from __future__ import annotations

import ctypes
import json
import os
import platform
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable
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
    "select_preferred_audio_source",
    "plan_cache_window",
    "plan_playlist_order",
    "decide_playlist_duplicate",
    "apply_av_delay_action",
)

MAX_UPDATE_DOWNLOAD_CANDIDATE_INPUTS = 4096
MAX_MEDIA_DOWNLOAD_STREAM_INPUTS = 4096
MAX_MEDIA_DOWNLOAD_CANDIDATES = 16384
MAX_TOOL_FALLBACK_BASES = 256
MAX_STREAM_RANKING_INPUTS = 512
MAX_CODEC_STRING_BYTES = 256
MAX_QUALITY_LABEL_BYTES = 256
MAX_CACHE_PLAN_ITEMS = 10_000
MAX_CACHE_ITEM_ID_BYTES = 512
MAX_PLAYLIST_PLAN_ITEMS = 10_000
MAX_PLAYLIST_SESSION_USERS = 32
MAX_PLAYLIST_STRING_BYTES = 512
MAX_PLAYLIST_HISTORY_KEY_BYTES = 8192
MAX_PLAYLIST_AUDIO_PAGES = 256

RUST_STRICT_EQUIVALENCE_ENV = "BILIKARA_RUST_STRICT_EQUIVALENCE"
RUST_TIMING_DIAGNOSTICS_ENV = "BILIKARA_RUST_TIMING_DIAGNOSTICS"
_TIMING_LOCK = threading.Lock()
_TIMING_DIAGNOSTICS: dict[str, dict[str, int | float]] = {}


def _env_enabled(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def strict_equivalence_enabled() -> bool:
    """Return whether exact Rust/Python migration comparisons are enabled."""

    return _env_enabled(RUST_STRICT_EQUIVALENCE_ENV)


def timing_diagnostics_enabled() -> bool:
    return _env_enabled(RUST_TIMING_DIAGNOSTICS_ENV)


def _record_timing(capability: str, **values: int | float) -> None:
    if not timing_diagnostics_enabled():
        return
    with _TIMING_LOCK:
        metrics = _TIMING_DIAGNOSTICS.setdefault(capability, {})
        for key, value in values.items():
            metrics[key] = metrics.get(key, 0) + value


def timing_diagnostics_snapshot(*, reset: bool = False) -> dict[str, dict[str, int | float]]:
    """Return aggregated migration timings without emitting per-call logs."""

    with _TIMING_LOCK:
        snapshot = {
            capability: dict(metrics)
            for capability, metrics in sorted(_TIMING_DIAGNOSTICS.items())
        }
        if reset:
            _TIMING_DIAGNOSTICS.clear()
    return snapshot


def python_fallback(capability: str, callback: Callable[[], Any]) -> Any:
    """Run one lazy Python fallback and optionally account for its cost."""

    if not timing_diagnostics_enabled():
        return callback()
    started = time.perf_counter()
    try:
        return callback()
    finally:
        _record_timing(
            capability,
            python_fallback_count=1,
            python_fallback_elapsed_seconds=time.perf_counter() - started,
        )


def _call_json_capability(
    capability: str,
    symbol_name: str,
    request: dict[str, object],
) -> object | None:
    """Encode, invoke, and decode one JSON FFI request with aggregate timing."""

    _record_timing(capability, call_count=1)
    if _rust_lib is None or not _CAPABILITIES.get(capability, False):
        return None
    try:
        encode_started = time.perf_counter()
        payload = json.dumps(
            request,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        encode_elapsed = time.perf_counter() - encode_started

        ffi_started = time.perf_counter()
        pointer = getattr(_rust_lib, symbol_name)(payload)
        response_json = _read_rust_string(pointer)
        ffi_elapsed = time.perf_counter() - ffi_started
        _record_timing(
            capability,
            rust_ffi_elapsed_seconds=ffi_elapsed,
            json_encode_elapsed_seconds=encode_elapsed,
        )
        if response_json is None:
            return None

        decode_started = time.perf_counter()
        response = json.loads(response_json)
        _record_timing(
            capability,
            json_decode_elapsed_seconds=time.perf_counter() - decode_started,
        )
        return response
    except Exception:
        return None


def _strict_equivalence_result(
    capability: str,
    response: dict[str, Any],
    reference_factory: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    if not strict_equivalence_enabled():
        return response

    started = time.perf_counter()
    reference = reference_factory()
    mismatch = response != reference
    _record_timing(
        capability,
        strict_equivalence_comparison_count=1,
        strict_equivalence_mismatch_count=int(mismatch),
        strict_reference_elapsed_seconds=time.perf_counter() - started,
    )
    if mismatch:
        print(
            f"[rust] strict equivalence mismatch for {capability}; using Python reference",
            file=sys.stderr,
            flush=True,
        )
        return reference
    return response


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
    "select_preferred_audio_source": (
        "rust_select_preferred_audio_source",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "plan_cache_window": (
        "rust_plan_cache_window",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "plan_playlist_order": (
        "rust_plan_playlist_order",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "decide_playlist_duplicate": (
        "rust_decide_playlist_duplicate",
        [ctypes.c_char_p],
        ctypes.c_void_p,
    ),
    "apply_av_delay_action": (
        "rust_apply_av_delay_action",
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
    status: dict[str, object] = {
        "loaded": _rust_lib is not None,
        "fully_compatible": _rust_lib is not None and not missing_capabilities,
        "error": _RUST_LOAD_ERROR,
        "path": str(_lib_path) if _lib_path else "",
        "capabilities": dict(_CAPABILITIES),
        "missing_capabilities": missing_capabilities,
        "abi_version": _ABI_VERSION,
        "expected_abi_version": EXPECTED_ABI_VERSION,
        "abi_compatible": _ABI_COMPATIBLE,
        "strict_equivalence": strict_equivalence_enabled(),
        "timing_diagnostics_enabled": timing_diagnostics_enabled(),
    }
    if timing_diagnostics_enabled():
        status["timing_diagnostics"] = timing_diagnostics_snapshot()
    return status


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
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "target",
        "assets",
    }:
        return None
    schema_version = request.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        return None

    target = request.get("target")
    if not isinstance(target, dict) or set(target) != {"platform", "arch"}:
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
        if not isinstance(asset, dict) or set(asset) != {
            "original_index",
            "name",
            "label",
            "browser_download_url",
            "content_type",
        }:
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
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "status",
        "selected_index",
        "scores",
    }:
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
        if not isinstance(item, dict) or set(item) != {"original_index", "score"}:
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


def _expected_asset_selection(request: dict[str, object]) -> dict[str, Any]:
    from .updater import _py_score_asset_for_target

    target = request["target"]
    assets = request["assets"]
    scores = [
        {
            "original_index": asset["original_index"],
            "score": _py_score_asset_for_target(asset, target),
        }
        for asset in assets
    ]
    selectable = [entry for entry in scores if entry["score"] >= 0]
    selected_index = None
    if selectable:
        highest = max(entry["score"] for entry in selectable)
        selected_index = next(
            entry["original_index"]
            for entry in selectable
            if entry["score"] == highest
        )
    return {
        "schema_version": 1,
        "status": "selected" if selected_index is not None else "no_match",
        "selected_index": selected_index,
        "scores": scores,
    }


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
    if request_indices is None:
        return False, None
    response = _call_json_capability(
        "select_update_asset", "rust_select_update_asset", request
    )
    if not _valid_asset_selection_response(response, request_indices):
        return False, None
    assert isinstance(response, dict)
    return True, _strict_equivalence_result(
        "select_update_asset",
        response,
        lambda: _expected_asset_selection(request),
    )


def try_select_release(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "current_version",
        "include_preview",
        "releases",
    }:
        return False, None
    schema_version = request.get("schema_version")
    releases = request.get("releases")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(request.get("current_version"), str)
        or not isinstance(request.get("include_preview"), bool)
        or not isinstance(releases, list)
        or len(releases) > MAX_PLAYLIST_PLAN_ITEMS
    ):
        return False, None
    for release in releases:
        if (
            not isinstance(release, dict)
            or set(release) != {"tag_name", "draft", "prerelease"}
            or not isinstance(release.get("tag_name"), str)
            or not isinstance(release.get("draft"), bool)
            or not isinstance(release.get("prerelease"), bool)
        ):
            return False, None

    response = _call_json_capability("select_release", "rust_select_release", request)
    try:
        if not isinstance(response, dict) or set(response) != {
            "schema_version",
            "status",
            "selected_index",
        }:
            return False, None

        schema_version = response.get("schema_version")
        if isinstance(schema_version, bool) or schema_version != 1:
            return False, None

        status = response.get("status")
        if status not in {"selected", "no_match"}:
            return False, None

        if status == "selected":
            selected_index = response.get("selected_index")
            if (
                isinstance(selected_index, bool)
                or not isinstance(selected_index, int)
                or selected_index < 0
                or selected_index >= len(releases)
            ):
                return False, None
        elif status == "no_match":
            selected_index = response.get("selected_index")
            if selected_index is not None:
                return False, None

        from .updater import _py_latest_release_for_current

        def reference() -> dict[str, Any]:
            releases = request.get("releases")
            assert isinstance(releases, list)
            selected = _py_latest_release_for_current(
                str(request.get("current_version") or ""),
                releases,
                include_preview=bool(request.get("include_preview")),
            )
            selected_index = None
            if selected:
                selected_index = next(
                    (
                        index
                        for index, release in enumerate(releases)
                        if release is selected
                    ),
                    None,
                )
            return {
                "schema_version": 1,
                "status": "selected" if selected_index is not None else "no_match",
                "selected_index": selected_index,
            }

        return True, _strict_equivalence_result(
            "select_release", response, reference
        )
    except Exception:
        return False, None


def try_select_media_pages(
    request: dict[str, Any],
) -> tuple[bool, dict[str, Any] | None]:
    try:
        if not isinstance(request, dict) or set(request) != {
            "schema_version",
            "preferred_page",
            "tolerance_seconds",
            "pages",
        }:
            return False, None
        schema_version = request.get("schema_version")
        preferred_page = request.get("preferred_page")
        tolerance_seconds = request.get("tolerance_seconds")
        if (
            isinstance(schema_version, bool)
            or schema_version != 1
            or isinstance(preferred_page, bool)
            or not isinstance(preferred_page, int)
            or not -(2**63) <= preferred_page <= 2**63 - 1
            or isinstance(tolerance_seconds, bool)
            or not isinstance(tolerance_seconds, int)
            or not 0 <= tolerance_seconds <= 2**63 - 1
        ):
            return False, None
        pages = request.get("pages")
        if not isinstance(pages, list) or len(pages) > MAX_PLAYLIST_PLAN_ITEMS:
            return False, None

        original_indices: set[int] = set()
        last_index: int | None = None
        for page in pages:
            if not isinstance(page, dict) or set(page) != {
                "original_index",
                "page",
                "cid",
                "duration",
                "part",
            }:
                return False, None
            idx = page.get("original_index")
            if (
                isinstance(idx, bool)
                or not isinstance(idx, int)
                or idx < 0
                or isinstance(page.get("page"), bool)
                or not isinstance(page.get("page"), int)
                or isinstance(page.get("cid"), bool)
                or not isinstance(page.get("cid"), int)
                or isinstance(page.get("duration"), bool)
                or not isinstance(page.get("duration"), int)
                or not isinstance(page.get("part"), str)
            ):
                return False, None
            if last_index is not None and idx <= last_index:
                return False, None
            last_index = idx
            original_indices.add(idx)

        response = _call_json_capability(
            "select_media_pages", "rust_select_media_pages", request
        )
        if not isinstance(response, dict) or set(response) != {
            "schema_version",
            "status",
            "selected_indices",
        }:
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

        from .bilibili import VideoPage, _py_select_matching_pages

        def reference() -> dict[str, Any]:
            source_pages = [
                VideoPage(
                    page=page["page"],
                    cid=page.get("cid", 0),
                    duration=page["duration"],
                    part=page.get("part", ""),
                )
                for page in pages
            ]
            selected = _py_select_matching_pages(
                source_pages,
                preferred_page=int(request.get("preferred_page", 1)),
                tolerance_seconds=int(request.get("tolerance_seconds", 0)),
            )
            selected_indices = [
                pages[source_pages.index(page)]["original_index"] for page in selected
            ]
            return {
                "schema_version": 1,
                "status": "selected" if selected_indices else "no_match",
                "selected_indices": selected_indices,
            }

        return True, _strict_equivalence_result(
            "select_media_pages", response, reference
        )
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
    if request_indices is None:
        return False, None
    response = _call_json_capability(
        "decide_audio_binding", "rust_decide_audio_binding", request
    )
    if not _valid_audio_binding_response(response, request_indices):
        return False, None
    assert isinstance(response, dict)
    from .bilibili import VideoPage, _py_decide_audio_binding

    def reference() -> dict[str, Any]:
        pages = [
            VideoPage(
                page=page["page"],
                cid=0,
                duration=page["duration"],
                part=page["part"],
            )
            for page in request["pages"]
        ]
        decision = _py_decide_audio_binding(
            pages, int(request["tolerance_seconds"])
        )
        if decision is None:
            return {
                "schema_version": 1,
                "status": "no_match",
                "mode": None,
                "selected_indices": [],
                "automatic_video_index": None,
            }
        selected_indices = [
            request_indices[index] for index in decision.selected_indices
        ]
        automatic_video_index = (
            request_indices[decision.automatic_video_index]
            if decision.automatic_video_index is not None
            else None
        )
        return {
            "schema_version": 1,
            "status": "decided",
            "mode": decision.mode,
            "selected_indices": selected_indices,
            "automatic_video_index": automatic_video_index,
        }

    return True, _strict_equivalence_result(
        "decide_audio_binding", response, reference
    )


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

    seen_urls: set[str] = set()
    request_by_index = {
        candidate["original_index"]: candidate for candidate in candidates
    }
    request_positions = {
        candidate["original_index"]: position
        for position, candidate in enumerate(candidates)
    }
    previous_order_key: tuple[int, int] | None = None
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
        request_candidate = request_by_index[input_index]
        direct_url = str(request_candidate["url"]).strip()
        expected_url = direct_url
        if route == "proxy":
            assert proxy is not None
            expected_url = _py_format_proxy_for_validation(
                str(proxy["template"]), direct_url
            ).strip()
        if not direct_url or not expected_url or url != expected_url:
            return False
        route_rank = int(
            (route == "direct")
            if proxy is not None and proxy["proxy_first"] is True
            else (route == "proxy")
        )
        order_key = (request_positions[input_index], route_rank)
        if previous_order_key is not None and order_key <= previous_order_key:
            return False
        previous_order_key = order_key
        seen_urls.add(url)
    expected_urls: set[str] = set()
    for request_candidate in candidates:
        direct_url = str(request_candidate["url"]).strip()
        if not direct_url:
            continue
        expected_urls.add(direct_url)
        if proxy is not None:
            proxy_url = _py_format_proxy_for_validation(
                str(proxy["template"]), direct_url
            ).strip()
            if proxy_url:
                expected_urls.add(proxy_url)
    if seen_urls != expected_urls:
        return False
    return (status == "empty" and not planned) or (
        status == "planned" and bool(planned)
    )


def try_plan_update_download_candidates(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly validate updater-only candidate planning."""

    validated_request = _update_download_plan_request(request)
    if validated_request is None:
        return False, None
    candidates, proxy = validated_request
    response = _call_json_capability(
        "plan_update_download_candidates",
        "rust_plan_update_download_candidates",
        request,
    )
    if not _valid_update_download_plan_response(response, candidates, proxy):
        return False, None
    assert isinstance(response, dict)

    def reference() -> dict[str, Any]:
        expected_candidates = _expected_update_download_candidates(candidates, proxy)
        return {
            "schema_version": 1,
            "status": "planned" if expected_candidates else "empty",
            "candidates": expected_candidates,
        }

    response = _strict_equivalence_result(
        "plan_update_download_candidates",
        response,
        reference,
    )
    return True, response


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
    seen_identities: set[tuple[int, str, int | None]] = set()
    previous_order_key: tuple[int, int] | None = None
    stream_positions = {
        stream["original_index"]: position for position, stream in enumerate(streams)
    }
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
        identity = (stream_index, source, backup_index)
        if identity in seen_identities:
            return False
        seen_identities.add(identity)
        stream = request_by_index[stream_index]
        raw_expected_url = (
            stream["primary_url"]
            if source == "primary"
            else stream["backup_urls"][backup_index]
        )
        expected_url = (
            str(raw_expected_url).strip()
            if mode == "dash_streams"
            else str(raw_expected_url)
        )
        if url != expected_url:
            return False
        candidate_rank = 0 if source == "primary" else int(backup_index) + 1
        order_key = (stream_positions[stream_index], candidate_rank)
        if previous_order_key is not None and order_key <= previous_order_key:
            return False
        previous_order_key = order_key
    expected_identities: set[tuple[int, str, int | None]] = set()
    for stream in streams:
        primary_url = str(stream["primary_url"])
        if mode != "dash_streams" or primary_url.strip():
            expected_identities.add((stream["original_index"], "primary", None))
        for backup_index, backup_url in enumerate(stream["backup_urls"]):
            if mode != "dash_streams" or str(backup_url).strip():
                expected_identities.add(
                    (stream["original_index"], "backup", backup_index)
                )
    if seen_identities != expected_identities:
        return False
    return (status == "empty" and not candidates) or (
        status == "planned" and bool(candidates)
    )


def try_plan_media_download_candidates(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly validate media primary/backup URL planning."""

    validated = _media_download_plan_request(request)
    if validated is None:
        return False, None
    mode, _stream_kind, streams = validated
    response = _call_json_capability(
        "plan_media_download_candidates",
        "rust_plan_media_download_candidates",
        request,
    )
    if not _valid_media_download_plan_response(response, mode, streams):
        return False, None
    assert isinstance(response, dict)

    def reference() -> dict[str, Any]:
        expected_candidates = _expected_media_download_candidates(mode, streams)
        return {
            "schema_version": 1,
            "status": "planned" if expected_candidates else "empty",
            "candidates": expected_candidates,
        }

    response = _strict_equivalence_result(
        "plan_media_download_candidates",
        response,
        reference,
    )
    return True, response


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
    asset: dict[str, object] | list[dict[str, object]],
    fallback_bases: list[dict[str, object]] | None = None,
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
        or len(candidates)
        > (
            len(asset)
            if fallback_bases is None and isinstance(asset, list)
            else len(fallback_bases or []) + 1
        )
    ):
        return False
    if fallback_bases is None:
        return (
            isinstance(asset, list)
            and candidates == asset
            and (
                (status == "empty" and not candidates)
                or (status == "planned" and bool(candidates))
            )
        )
    assert isinstance(asset, dict)
    seen: set[str] = set()
    seen_identities: set[tuple[str, int | None]] = set()
    fallback_positions = {
        fallback["original_index"]: position
        for position, fallback in enumerate(fallback_bases)
    }
    fallback_by_index = {
        fallback["original_index"]: fallback for fallback in fallback_bases
    }
    previous_order_key = -1
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
            if (
                isinstance(fallback_index, bool)
                or not isinstance(fallback_index, int)
                or fallback_index not in fallback_by_index
            ):
                return False
            expected_url = (
                f"{fallback_by_index[fallback_index]['base_url']}/"
                f"{urllib.parse.quote(expected_asset_name)}"
            )
            order_key = fallback_positions[fallback_index] + 1
        elif fallback_index is not None:
            return False
        else:
            if asset["mode"] == "supplied":
                expected_source = "supplied_primary"
                expected_url = str(asset["primary_url"])
            elif tool == "aria2c":
                expected_source = "built_in_primary"
                expected_url = (
                    "https://github.com/aria2/aria2/releases/download/"
                    f"release-1.37.0/{urllib.parse.quote(expected_asset_name)}"
                )
            else:
                return False
            if source != expected_source:
                return False
            order_key = 0
        if url != expected_url or order_key <= previous_order_key:
            return False
        previous_order_key = order_key
        identity = (source, fallback_index)
        if identity in seen_identities:
            return False
        seen_identities.add(identity)
        seen.add(url)
    expected_urls: set[str] = set()
    if asset["mode"] == "supplied" and str(asset["primary_url"]):
        expected_urls.add(str(asset["primary_url"]))
    elif asset["mode"] == "default_for_target" and tool == "aria2c":
        expected_urls.add(
            "https://github.com/aria2/aria2/releases/download/"
            f"release-1.37.0/{urllib.parse.quote(expected_asset_name)}"
        )
    for fallback in fallback_bases:
        base_url = str(fallback["base_url"])
        if base_url:
            expected_urls.add(
                f"{base_url}/{urllib.parse.quote(expected_asset_name)}"
            )
    if seen != expected_urls:
        return False
    return (status == "empty" and not candidates) or (
        status == "planned" and bool(candidates)
    )


def try_plan_tool_download_candidates(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly validate tool asset candidate planning."""

    validated = _tool_download_plan_request(request)
    if validated is None:
        return False, None
    tool, asset, fallback_bases = validated
    expected_asset_name = (
        str(asset["name"])
        if asset["mode"] == "supplied"
        else _default_tool_asset_name(
            tool, str(asset["platform"]), str(asset["arch"])
        )
    )
    if expected_asset_name is None:
        return False, None
    response = _call_json_capability(
        "plan_tool_download_candidates",
        "rust_plan_tool_download_candidates",
        request,
    )
    if not _valid_tool_download_plan_response(
        response, tool, expected_asset_name, asset, fallback_bases
    ):
        return False, None
    assert isinstance(response, dict)

    def reference() -> dict[str, Any]:
        expected = _expected_tool_download_plan(tool, asset, fallback_bases)
        assert expected is not None
        asset_name, expected_candidates = expected
        return {
            "schema_version": 1,
            "status": "planned" if expected_candidates else "empty",
            "tool": tool,
            "asset_name": asset_name,
            "candidates": expected_candidates,
        }

    return True, _strict_equivalence_result(
        "plan_tool_download_candidates", response, reference
    )


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
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "status",
        "normalized_quality",
        "optional_quality",
        "optional_cap",
        "indexed_quality",
        "dash_max_quality_id",
        "effective_max_height",
        "bbdown_quality_order",
    }:
        return False
    normalized = response.get("normalized_quality")
    optional_quality = response.get("optional_quality")
    optional_cap = response.get("optional_cap")
    indexed_quality = response.get("indexed_quality")
    order = response.get("bbdown_quality_order")
    if (
        response.get("schema_version") != 1
        or isinstance(response.get("schema_version"), bool)
        or response.get("status") != "decided"
        or normalized not in _ACTIVE_VIDEO_QUALITIES
        or optional_quality not in (None, *_ACTIVE_VIDEO_QUALITIES)
        or optional_cap not in (None, *_ACTIVE_VIDEO_QUALITIES)
        or indexed_quality not in (None, *_ACTIVE_VIDEO_QUALITIES)
        or isinstance(response.get("dash_max_quality_id"), bool)
        or not isinstance(response.get("dash_max_quality_id"), int)
        or response.get("dash_max_quality_id") not in set(_DASH_QUALITY_IDS.values())
        or isinstance(response.get("effective_max_height"), bool)
        or response.get("effective_max_height") not in {360, 480, 720, 1080, 2160, 4320}
        or not isinstance(order, list)
        or not order
        or len(set(order)) != len(order)
        or any(value not in _ACTIVE_VIDEO_QUALITIES for value in order)
    ):
        return False
    raw_quality = str(request["raw_quality"])
    raw_cap = str(request["raw_cap"])
    expected_optional_quality = (
        raw_quality.strip()
        if raw_quality.strip() in _ACTIVE_VIDEO_QUALITIES
        else None
    )
    expected_normalized = expected_optional_quality or _DEFAULT_VIDEO_QUALITY
    expected_optional_cap = (
        raw_cap.strip() if raw_cap.strip() in _ACTIVE_VIDEO_QUALITIES else None
    )
    choice_index = request["choice_index"]
    expected_indexed_quality = (
        _ACTIVE_VIDEO_QUALITIES[choice_index]
        if isinstance(choice_index, int)
        and not isinstance(choice_index, bool)
        and 0 <= choice_index < len(_ACTIVE_VIDEO_QUALITIES)
        else None
    )
    effective_quality = expected_optional_cap or expected_normalized
    expected_height = next(
        (
            height
            for marker, height in (
                ("360", 360),
                ("480", 480),
                ("720", 720),
                ("1080", 1080),
                ("4K", 2160),
                ("8K", 4320),
            )
            if marker in effective_quality
        ),
        1080,
    )
    if (
        normalized != expected_normalized
        or optional_quality != expected_optional_quality
        or optional_cap != expected_optional_cap
        or indexed_quality != expected_indexed_quality
        or response.get("dash_max_quality_id")
        != _DASH_QUALITY_IDS.get(raw_quality, 80)
        or response.get("effective_max_height") != expected_height
    ):
        return False
    start_index = _ACTIVE_VIDEO_QUALITIES.index(normalized)
    if optional_cap is not None:
        start_index = max(start_index, _ACTIVE_VIDEO_QUALITIES.index(optional_cap))
    return order == list(_ACTIVE_VIDEO_QUALITIES[start_index:])


def try_decide_quality_policy(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly reconstruct the canonical quality-policy decision."""

    validated = _quality_policy_request(request)
    if validated is None:
        return False, None
    response = _call_json_capability(
        "decide_quality_policy", "rust_decide_quality_policy", validated
    )
    if not _valid_quality_policy_response(response, validated):
        return False, None
    assert isinstance(response, dict)
    return True, _strict_equivalence_result(
        "decide_quality_policy",
        response,
        lambda: _expected_quality_policy(validated),
    )


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


def _valid_stream_ranking_response(
    response: object,
    request_indices: list[int],
    allowed_reasons: set[str],
) -> bool:
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "status",
        "selected_index",
        "ranked_indices",
        "reason",
    }:
        return False
    schema_version = response.get("schema_version")
    status = response.get("status")
    selected_index = response.get("selected_index")
    ranked_indices = response.get("ranked_indices")
    reason = response.get("reason")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or status not in {"selected", "no_match"}
        or not isinstance(ranked_indices, list)
        or len(ranked_indices) > len(request_indices)
        or len(set(ranked_indices)) != len(ranked_indices)
        or any(
            isinstance(index, bool)
            or not isinstance(index, int)
            or index not in request_indices
            for index in ranked_indices
        )
    ):
        return False
    if status == "no_match":
        return selected_index is None and ranked_indices == [] and reason is None
    return (
        bool(ranked_indices)
        and selected_index == ranked_indices[0]
        and reason in allowed_reasons
    )


def _valid_video_stream_response(
    response: object, request: dict[str, object]
) -> bool:
    return _valid_stream_ranking_response(
        response,
        [stream["original_index"] for stream in request["streams"]],
        {"preferred", "quality_fallback", "uncapped_fallback"},
    )


def try_select_video_stream(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly reconstruct DASH video ranking."""

    validated = _video_stream_request(request)
    if validated is None:
        return False, None
    response = _call_json_capability(
        "select_video_stream", "rust_select_video_stream", validated
    )
    if not _valid_video_stream_response(response, validated):
        return False, None
    assert isinstance(response, dict)
    return True, _strict_equivalence_result(
        "select_video_stream",
        response,
        lambda: _expected_video_stream_selection(validated),
    )


def _audio_stream_request(request: object) -> dict[str, object] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "audio_hires",
        "regular_streams",
    }:
        return None
    schema_version = request.get("schema_version")
    audio_hires = request.get("audio_hires")
    streams = request.get("regular_streams")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(audio_hires, bool)
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
    selected_index = ranked_indices[0] if ranked_indices else None
    return {
        "schema_version": 1,
        "status": "selected" if selected_index is not None else "no_match",
        "selected_index": selected_index,
        "ranked_indices": ranked_indices,
        "reason": regular_reason,
    }


def _valid_audio_stream_response(
    response: object, request: dict[str, object]
) -> bool:
    return _valid_stream_ranking_response(
        response,
        [stream["original_index"] for stream in request["regular_streams"]],
        {"hires_enabled", "standard_only", "hires_only_fallback"},
    )


def try_select_audio_stream(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly reconstruct regular DASH audio ranking."""

    validated = _audio_stream_request(request)
    if validated is None:
        return False, None
    response = _call_json_capability(
        "select_audio_stream", "rust_select_audio_stream", validated
    )
    if not _valid_audio_stream_response(response, validated):
        return False, None
    assert isinstance(response, dict)
    return True, _strict_equivalence_result(
        "select_audio_stream",
        response,
        lambda: _expected_audio_stream_selection(validated),
    )


def _preferred_audio_source_request(request: object) -> dict[str, object] | None:
    if not isinstance(request, dict) or set(request) != {
        "schema_version",
        "audio_hires",
        "regular_candidates",
        "flac_available",
        "dolby_available",
    }:
        return None
    schema_version = request.get("schema_version")
    audio_hires = request.get("audio_hires")
    candidates = request.get("regular_candidates")
    flac_available = request.get("flac_available")
    dolby_available = request.get("dolby_available")
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(audio_hires, bool)
        or not isinstance(candidates, list)
        or len(candidates) > MAX_STREAM_RANKING_INPUTS
        or not isinstance(flac_available, bool)
        or not isinstance(dolby_available, bool)
    ):
        return None
    validated_candidates: list[dict[str, int]] = []
    previous_index: int | None = None
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) != {"original_index"}:
            return None
        original_index = candidate.get("original_index")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or not 0 <= original_index <= _USIZE_MAX
            or (previous_index is not None and original_index <= previous_index)
        ):
            return None
        previous_index = original_index
        validated_candidates.append({"original_index": original_index})
    return {
        "schema_version": 1,
        "audio_hires": audio_hires,
        "regular_candidates": validated_candidates,
        "flac_available": flac_available,
        "dolby_available": dolby_available,
    }


def _expected_preferred_audio_source_selection(
    request: dict[str, object],
) -> dict[str, object]:
    candidates = list(request["regular_candidates"])
    selected_regular_index = (
        candidates[0]["original_index"] if candidates else None
    )
    if request["audio_hires"] and request["dolby_available"]:
        preferred_source = "dolby"
    elif request["audio_hires"] and request["flac_available"]:
        preferred_source = "flac"
    elif selected_regular_index is not None:
        preferred_source = "regular"
    else:
        preferred_source = None
    return {
        "schema_version": 1,
        "status": "selected" if preferred_source is not None else "no_match",
        "preferred_source": preferred_source,
        "selected_regular_index": selected_regular_index,
    }


def _valid_preferred_audio_source_response(
    response: object, request: dict[str, object]
) -> bool:
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "status",
        "preferred_source",
        "selected_regular_index",
    }:
        return False
    candidates = request["regular_candidates"]
    candidate_indices = [candidate["original_index"] for candidate in candidates]
    selected_regular_index = response.get("selected_regular_index")
    preferred_source = response.get("preferred_source")
    status = response.get("status")
    if (
        response.get("schema_version") != 1
        or isinstance(response.get("schema_version"), bool)
        or status not in {"selected", "no_match"}
        or selected_regular_index
        not in (None, *candidate_indices)
        or preferred_source not in {None, "regular", "flac", "dolby"}
    ):
        return False
    if selected_regular_index is not None and selected_regular_index != candidate_indices[0]:
        return False
    if status == "no_match":
        return preferred_source is None and selected_regular_index is None
    if preferred_source == "regular":
        return selected_regular_index is not None
    if preferred_source == "flac":
        return bool(request["audio_hires"] and request["flac_available"])
    if preferred_source == "dolby":
        return bool(request["audio_hires"] and request["dolby_available"])
    return False


def try_select_preferred_audio_source(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call and strictly reconstruct preferred DASH audio source binding."""

    validated = _preferred_audio_source_request(request)
    if validated is None:
        return False, None
    response = _call_json_capability(
        "select_preferred_audio_source",
        "rust_select_preferred_audio_source",
        validated,
    )
    if not _valid_preferred_audio_source_response(response, validated):
        return False, None
    assert isinstance(response, dict)
    return True, _strict_equivalence_result(
        "select_preferred_audio_source",
        response,
        lambda: _expected_preferred_audio_source_selection(validated),
    )


def _cache_plan_request(request: object) -> dict[str, object] | None:
    required_fields = {
        "schema_version",
        "items",
        "max_items",
        "retention_limit",
        "active_item_ids",
        "primary_active_item_id",
        "urgent_item_ids",
    }
    if not isinstance(request, dict) or set(request) != required_fields:
        return None
    schema_version = request.get("schema_version")
    items = request.get("items")
    max_items = request.get("max_items")
    retention_limit = request.get("retention_limit")
    active_item_ids = request.get("active_item_ids")
    primary_active_item_id = request.get("primary_active_item_id")
    urgent_item_ids = request.get("urgent_item_ids")
    size_t_max = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(items, list)
        or len(items) > MAX_CACHE_PLAN_ITEMS
        or isinstance(max_items, bool)
        or not isinstance(max_items, int)
        or not 0 <= max_items <= size_t_max
        or isinstance(retention_limit, bool)
        or not isinstance(retention_limit, int)
        or not 0 <= retention_limit <= size_t_max
        or not isinstance(active_item_ids, list)
        or not isinstance(urgent_item_ids, list)
        or primary_active_item_id is not None
        and not isinstance(primary_active_item_id, str)
    ):
        return None

    validated_items: list[dict[str, object]] = []
    item_ids: set[str] = set()
    indices: set[int] = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {
            "original_index",
            "item_id",
            "cache_ready",
        }:
            return None
        original_index = item.get("original_index")
        item_id = item.get("item_id")
        cache_ready = item.get("cache_ready")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or not 0 <= original_index <= size_t_max
            or not isinstance(item_id, str)
            or not item_id
            or len(item_id.encode("utf-8")) > MAX_CACHE_ITEM_ID_BYTES
            or "\x00" in item_id
            or not isinstance(cache_ready, bool)
            or original_index in indices
            or item_id in item_ids
        ):
            return None
        indices.add(original_index)
        item_ids.add(item_id)
        validated_items.append(
            {
                "original_index": original_index,
                "item_id": item_id,
                "cache_ready": cache_ready,
            }
        )

    def valid_references(value: list[object]) -> bool:
        return (
            len(value) <= len(items)
            and all(isinstance(item_id, str) and item_id in item_ids for item_id in value)
            and len(set(value)) == len(value)
        )

    if not valid_references(active_item_ids) or not valid_references(urgent_item_ids):
        return None
    if primary_active_item_id is not None and (
        primary_active_item_id not in item_ids
        or primary_active_item_id not in active_item_ids
    ):
        return None
    return {
        "schema_version": 1,
        "items": validated_items,
        "max_items": max_items,
        "retention_limit": retention_limit,
        "active_item_ids": list(active_item_ids),
        "primary_active_item_id": primary_active_item_id,
        "urgent_item_ids": list(urgent_item_ids),
    }


def _expected_cache_plan(request: dict[str, object]) -> dict[str, object]:
    # Local import avoids a module-load cycle: cache.py owns the independent
    # policy reference and imports this native adapter.
    from .cache import (
        CachePlanItem,
        CachePlanRequest,
        _py_plan_cache_window,
    )

    items = request["items"]
    assert isinstance(items, list)
    plan = _py_plan_cache_window(
        CachePlanRequest(
            items=tuple(
                CachePlanItem(
                    original_index=item["original_index"],
                    item_id=item["item_id"],
                    cache_ready=item["cache_ready"],
                )
                for item in items
            ),
            max_items=request["max_items"],
            retention_limit=request["retention_limit"],
            active_item_ids=tuple(request["active_item_ids"]),
            primary_active_item_id=request["primary_active_item_id"],
            urgent_item_ids=tuple(request["urgent_item_ids"]),
        )
    )
    return {
        "schema_version": 1,
        "desired_ids": list(plan.desired_ids),
        "pending_order": list(plan.pending_order),
        "retained_ids": list(plan.retained_ids),
        "preempt_ids": list(plan.preempt_ids),
    }


def _valid_cache_plan_response(
    response: object,
    request: dict[str, object],
) -> bool:
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "desired_ids",
        "pending_order",
        "retained_ids",
        "preempt_ids",
    }:
        return False
    if isinstance(response.get("schema_version"), bool) or response.get("schema_version") != 1:
        return False
    items = request["items"]
    assert isinstance(items, list)
    known_ids = [item["item_id"] for item in items]
    known_set = set(known_ids)
    for field in ("desired_ids", "pending_order", "retained_ids", "preempt_ids"):
        values = response.get(field)
        if (
            not isinstance(values, list)
            or any(not isinstance(item_id, str) or item_id not in known_set for item_id in values)
            or len(values) != len(set(values))
        ):
            return False
    desired_ids = response["desired_ids"]
    pending_order = response["pending_order"]
    retained_ids = response["retained_ids"]
    preempt_ids = response["preempt_ids"]
    if (
        not set(pending_order).issubset(desired_ids)
        or not set(desired_ids).issubset(retained_ids)
        or len(retained_ids) > len(desired_ids) + request["retention_limit"]
        or len(preempt_ids) > 1
        or any(item_id != request["primary_active_item_id"] for item_id in preempt_ids)
    ):
        return False
    expected_desired = known_ids[: min(len(known_ids), int(request["max_items"]))]
    ready_by_id = {item["item_id"]: item["cache_ready"] for item in items}
    expected_pending = [
        item_id for item_id in expected_desired if not ready_by_id[item_id]
    ]
    expected_retained = list(expected_desired)
    if int(request["max_items"]) > 0:
        for item_id in known_ids[len(expected_desired) :]:
            if len(expected_retained) >= len(expected_desired) + int(request["retention_limit"]):
                break
            if ready_by_id[item_id]:
                expected_retained.append(item_id)
    primary_id = request["primary_active_item_id"]
    expected_preempt = []
    if (
        primary_id is not None
        and expected_pending
        and primary_id in expected_pending[1:]
        and expected_pending[0] not in request["urgent_item_ids"]
    ):
        expected_preempt = [primary_id]
    return (
        desired_ids == expected_desired
        and pending_order == expected_pending
        and retained_ids == expected_retained
        and preempt_ids == expected_preempt
    )


def try_plan_cache_window(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call Rust and accept only the complete canonical cache plan."""

    validated = _cache_plan_request(request)
    if validated is None:
        return False, None
    response = _call_json_capability(
        "plan_cache_window", "rust_plan_cache_window", validated
    )
    if not _valid_cache_plan_response(response, validated):
        return False, None
    assert isinstance(response, dict)
    return True, _strict_equivalence_result(
        "plan_cache_window", response, lambda: _expected_cache_plan(validated)
    )


def _av_delay_request(request: object) -> dict[str, object] | None:
    if not isinstance(request, dict) or set(request) != {"schema_version", "state", "action"}:
        return None
    state = request.get("state")
    action = request.get("action")
    if (
        request.get("schema_version") != 1
        or isinstance(request.get("schema_version"), bool)
        or not isinstance(state, dict)
        or set(state) != {"global_delay_ms", "local_delay_ms", "locked"}
        or not isinstance(action, dict)
        or not isinstance(state.get("locked"), bool)
    ):
        return None
    global_delay = state.get("global_delay_ms")
    local_delay = state.get("local_delay_ms")
    if (
        isinstance(global_delay, bool)
        or not isinstance(global_delay, int)
        or isinstance(local_delay, bool)
        or not isinstance(local_delay, int)
        or not -5000 <= global_delay <= 5000
        or not -5000 <= global_delay + local_delay <= 5000
    ):
        return None
    action_type = action.get("type")
    expected_fields = {
        "snapshot": {"type"},
        "set_effective": {"type", "effective_delay_ms"},
        "set_persistent": {"type", "effective_delay_ms"},
        "adjust": {"type", "delta_ms"},
        "reset_local": {"type"},
        "toggle_lock": {"type"},
    }
    if action_type not in expected_fields or set(action) != expected_fields[action_type]:
        return None
    numeric_field = (
        "effective_delay_ms"
        if action_type in {"set_effective", "set_persistent"}
        else "delta_ms"
    )
    if numeric_field in action:
        value = action[numeric_field]
        if isinstance(value, bool) or not isinstance(value, int) or not -(2**31) <= value < 2**31:
            return None
    return request


def try_apply_av_delay_action(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call Rust and accept only the canonical AV-delay transition result."""

    validated = _av_delay_request(request)
    if validated is None:
        return False, None
    response = _call_json_capability(
        "apply_av_delay_action", "rust_apply_av_delay_action", validated
    )
    integer_fields = {
        "schema_version",
        "global_delay_ms",
        "local_delay_ms",
        "effective_delay_ms",
    }
    boolean_fields = {"locked", "has_local_adjustment", "lock_button_enabled"}
    if (
        not isinstance(response, dict)
        or set(response) != integer_fields | boolean_fields
        or any(
            isinstance(response.get(field), bool)
            or not isinstance(response.get(field), int)
            for field in integer_fields
        )
        or any(not isinstance(response.get(field), bool) for field in boolean_fields)
        or response.get("schema_version") != 1
        or not -5000 <= int(response["global_delay_ms"]) <= 5000
        or not -5000 <= int(response["effective_delay_ms"]) <= 5000
        or response["effective_delay_ms"]
        != response["global_delay_ms"] + response["local_delay_ms"]
        or response["has_local_adjustment"] != (response["local_delay_ms"] != 0)
        or response["lock_button_enabled"]
        != bool(response["locked"] or response["effective_delay_ms"] != 0)
    ):
        return False, None
    state = validated["state"]
    action = validated["action"]
    assert isinstance(state, dict) and isinstance(action, dict)
    expected_global = int(state["global_delay_ms"])
    expected_local = int(state["local_delay_ms"])
    expected_locked = bool(state["locked"])
    action_type = str(action["type"])

    def bounded(value: int) -> int:
        return max(-5000, min(5000, value))

    if action_type == "set_effective":
        expected_local = bounded(int(action["effective_delay_ms"])) - expected_global
    elif action_type == "set_persistent":
        expected_global = bounded(int(action["effective_delay_ms"]))
        expected_local = 0
        expected_locked = expected_global != 0
    elif action_type == "adjust":
        expected_local = (
            bounded(expected_global + expected_local + int(action["delta_ms"]))
            - expected_global
        )
    elif action_type == "reset_local":
        expected_local = 0
    elif action_type == "toggle_lock" and expected_locked:
        expected_local += expected_global
        expected_global = 0
        expected_locked = False
    elif action_type == "toggle_lock" and expected_local != 0:
        expected_global += expected_local
        expected_local = 0
        expected_locked = True
    if (
        response["global_delay_ms"] != expected_global
        or response["local_delay_ms"] != expected_local
        or response["locked"] != expected_locked
    ):
        return False, None
    from .store import _py_apply_av_delay_action

    return True, _strict_equivalence_result(
        "apply_av_delay_action",
        response,
        lambda: _py_apply_av_delay_action(validated["state"], validated["action"]),
    )


def _playlist_order_request(request: object) -> dict[str, object] | None:
    required_fields = {
        "schema_version",
        "operation",
        "session_users",
        "current_requester",
        "items",
        "candidate",
    }
    if not isinstance(request, dict) or set(request) != required_fields:
        return None
    schema_version = request.get("schema_version")
    operation = request.get("operation")
    session_users = request.get("session_users")
    current_requester = request.get("current_requester")
    items = request.get("items")
    candidate = request.get("candidate")
    size_t_max = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1

    def valid_string(value: object, *, allow_empty: bool = False) -> bool:
        return (
            isinstance(value, str)
            and (allow_empty or bool(value))
            and "\x00" not in value
            and len(value.encode("utf-8")) <= MAX_PLAYLIST_STRING_BYTES
        )

    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or operation not in {"rebuild", "insert_cycle"}
        or not isinstance(session_users, list)
        or len(session_users) > MAX_PLAYLIST_SESSION_USERS
        or any(not valid_string(name) for name in session_users)
        or len(set(session_users)) != len(session_users)
        or current_requester is not None
        and not valid_string(current_requester, allow_empty=True)
        or not isinstance(items, list)
        or len(items) > MAX_PLAYLIST_PLAN_ITEMS
    ):
        return None

    def validated_item(value: object) -> dict[str, object] | None:
        if not isinstance(value, dict) or set(value) != {
            "original_index",
            "item_id",
            "requester_name",
            "slot_type",
        }:
            return None
        original_index = value.get("original_index")
        item_id = value.get("item_id")
        requester_name = value.get("requester_name")
        slot_type = value.get("slot_type")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or not 0 <= original_index <= size_t_max
            or not valid_string(item_id)
            or not valid_string(requester_name, allow_empty=True)
            or slot_type not in {"cycle", "priority", "manual"}
        ):
            return None
        return {
            "original_index": original_index,
            "item_id": item_id,
            "requester_name": requester_name,
            "slot_type": slot_type,
        }

    validated_items: list[dict[str, object]] = []
    item_ids: set[str] = set()
    indices: set[int] = set()
    for item in items:
        validated = validated_item(item)
        if validated is None:
            return None
        item_id = validated["item_id"]
        original_index = validated["original_index"]
        if item_id in item_ids or original_index in indices:
            return None
        item_ids.add(item_id)
        indices.add(original_index)
        validated_items.append(validated)

    validated_candidate = None
    if operation == "rebuild":
        if candidate is not None:
            return None
    else:
        validated_candidate = validated_item(candidate)
        if (
            validated_candidate is None
            or validated_candidate["slot_type"] != "cycle"
            or validated_candidate["item_id"] in item_ids
            or validated_candidate["original_index"] in indices
            or len(items) >= MAX_PLAYLIST_PLAN_ITEMS
        ):
            return None
    return {
        "schema_version": 1,
        "operation": operation,
        "session_users": list(session_users),
        "current_requester": current_requester,
        "items": validated_items,
        "candidate": validated_candidate,
    }


def _expected_playlist_order(request: dict[str, object]) -> dict[str, object]:
    from .store import (
        PlaylistOrderItem,
        PlaylistOrderRequest,
        _py_plan_playlist_order,
    )

    def item(value: dict[str, object]) -> PlaylistOrderItem:
        return PlaylistOrderItem(
            original_index=value["original_index"],
            item_id=value["item_id"],
            requester_name=value["requester_name"],
            slot_type=value["slot_type"],
        )

    items = request["items"]
    assert isinstance(items, list)
    candidate = request["candidate"]
    plan = _py_plan_playlist_order(
        PlaylistOrderRequest(
            operation=request["operation"],
            session_users=tuple(request["session_users"]),
            current_requester=request["current_requester"],
            items=tuple(item(value) for value in items),
            candidate=item(candidate) if isinstance(candidate, dict) else None,
        )
    )
    return {"schema_version": 1, "ordered_ids": list(plan.ordered_ids)}


def _valid_playlist_order_response(
    response: object,
    request: dict[str, object],
) -> bool:
    if not isinstance(response, dict) or set(response) != {"schema_version", "ordered_ids"}:
        return False
    if isinstance(response.get("schema_version"), bool) or response.get("schema_version") != 1:
        return False
    ordered_ids = response.get("ordered_ids")
    items = request["items"]
    assert isinstance(items, list)
    known_ids = [item["item_id"] for item in items]
    candidate = request["candidate"]
    if isinstance(candidate, dict):
        known_ids.append(candidate["item_id"])
    if (
        not isinstance(ordered_ids, list)
        or any(not isinstance(item_id, str) for item_id in ordered_ids)
        or len(ordered_ids) != len(known_ids)
        or len(set(ordered_ids)) != len(ordered_ids)
        or set(ordered_ids) != set(known_ids)
    ):
        return False
    users = list(request["session_users"])
    current_requester = request["current_requester"]
    if users and current_requester in users:
        start = (users.index(current_requester) + 1) % len(users)
        users = users[start:] + users[:start]
    user_positions = {name: index for index, name in enumerate(users)}
    requester_counts = {name: 0 for name in users}
    cycle_keys: dict[str, tuple[int, int]] = {}
    for item in items:
        requester = item["requester_name"]
        if item["slot_type"] != "cycle" or requester not in user_positions:
            continue
        cycle_keys[item["item_id"]] = (
            requester_counts[requester],
            user_positions[requester],
        )
        requester_counts[requester] += 1

    expected_ids = [item["item_id"] for item in items]
    if request["operation"] == "insert_cycle":
        assert isinstance(candidate, dict)
        requester = candidate["requester_name"]
        if requester not in user_positions:
            expected_ids.append(candidate["item_id"])
        else:
            candidate_key = (requester_counts[requester], user_positions[requester])
            insert_at = 0
            for index, item in enumerate(items):
                existing_key = cycle_keys.get(item["item_id"])
                if item["slot_type"] != "cycle" or existing_key is None or existing_key <= candidate_key:
                    insert_at = index + 1
            expected_ids.insert(insert_at, candidate["item_id"])
    else:
        cycle_positions: list[int] = []
        sortable: list[tuple[tuple[int, int], int, str]] = []
        for position, item in enumerate(items):
            item_id = item["item_id"]
            if item["slot_type"] != "cycle" or item_id not in cycle_keys:
                continue
            cycle_positions.append(position)
            sortable.append((cycle_keys[item_id], item["original_index"], item_id))
        sortable.sort(key=lambda entry: (entry[0][0], entry[0][1], entry[1]))
        for position, (_, _, item_id) in zip(cycle_positions, sortable):
            expected_ids[position] = item_id
    return ordered_ids == expected_ids


def try_plan_playlist_order(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call Rust and accept only the exact canonical playlist order."""

    validated = _playlist_order_request(request)
    if validated is None:
        return False, None
    response = _call_json_capability(
        "plan_playlist_order", "rust_plan_playlist_order", validated
    )
    if not _valid_playlist_order_response(response, validated):
        return False, None
    assert isinstance(response, dict)
    return True, _strict_equivalence_result(
        "plan_playlist_order",
        response,
        lambda: _expected_playlist_order(validated),
    )


def _playlist_duplicate_request(request: object) -> dict[str, object] | None:
    required_fields = {
        "schema_version",
        "candidate",
        "current_item",
        "queued_items",
        "history_entries",
    }
    if not isinstance(request, dict) or set(request) != required_fields:
        return None
    schema_version = request.get("schema_version")
    current_item = request.get("current_item")
    queued_items = request.get("queued_items")
    history_entries = request.get("history_entries")
    size_t_max = 2 ** (ctypes.sizeof(ctypes.c_size_t) * 8) - 1
    i64_min = -(2**63)
    i64_max = 2**63 - 1
    u64_max = 2**64 - 1

    def valid_string(value: object, limit: int, *, allow_empty: bool = False) -> bool:
        return (
            isinstance(value, str)
            and (allow_empty or bool(value))
            and "\x00" not in value
            and len(value.encode("utf-8")) <= limit
        )

    def validated_identity(value: object) -> dict[str, object] | None:
        if not isinstance(value, dict) or set(value) != {
            "bvid",
            "aid",
            "video_page",
            "selected_audio_pages",
        }:
            return None
        bvid = value.get("bvid")
        aid = value.get("aid")
        video_page = value.get("video_page")
        selected_audio_pages = value.get("selected_audio_pages")
        if (
            not valid_string(bvid, MAX_PLAYLIST_STRING_BYTES, allow_empty=True)
            or isinstance(aid, bool)
            or not isinstance(aid, int)
            or not 0 <= aid <= u64_max
            or isinstance(video_page, bool)
            or not isinstance(video_page, int)
            or not 1 <= video_page <= size_t_max
            or not isinstance(selected_audio_pages, list)
            or len(selected_audio_pages) > MAX_PLAYLIST_AUDIO_PAGES
            or any(
                isinstance(page, bool)
                or not isinstance(page, int)
                or not i64_min <= page <= i64_max
                for page in selected_audio_pages
            )
        ):
            return None
        return {
            "bvid": bvid,
            "aid": aid,
            "video_page": video_page,
            "selected_audio_pages": list(selected_audio_pages),
        }

    def validated_active(value: object) -> dict[str, object] | None:
        if not isinstance(value, dict) or set(value) != {
            "original_index",
            "item_id",
            "identity",
        }:
            return None
        original_index = value.get("original_index")
        item_id = value.get("item_id")
        identity = validated_identity(value.get("identity"))
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or not 0 <= original_index <= size_t_max
            or not valid_string(item_id, MAX_PLAYLIST_STRING_BYTES)
            or identity is None
        ):
            return None
        return {
            "original_index": original_index,
            "item_id": item_id,
            "identity": identity,
        }

    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(queued_items, list)
        or len(queued_items) > MAX_PLAYLIST_PLAN_ITEMS
        or not isinstance(history_entries, list)
        or len(history_entries) > MAX_PLAYLIST_PLAN_ITEMS
    ):
        return None
    candidate = validated_identity(request.get("candidate"))
    if candidate is None:
        return None
    validated_current = None if current_item is None else validated_active(current_item)
    if current_item is not None and validated_current is None:
        return None
    validated_queued: list[dict[str, object]] = []
    active_ids: set[str] = set()
    active_indices: set[int] = set()
    for active in ([validated_current] if validated_current else []) + list(queued_items):
        validated = active if active is validated_current else validated_active(active)
        if validated is None:
            return None
        if validated["item_id"] in active_ids or validated["original_index"] in active_indices:
            return None
        active_ids.add(validated["item_id"])
        active_indices.add(validated["original_index"])
        if validated is not validated_current:
            validated_queued.append(validated)

    validated_history: list[dict[str, object]] = []
    history_indices: set[int] = set()
    for entry in history_entries:
        if not isinstance(entry, dict) or set(entry) != {"original_index", "key"}:
            return None
        original_index = entry.get("original_index")
        key = entry.get("key")
        if (
            isinstance(original_index, bool)
            or not isinstance(original_index, int)
            or not 0 <= original_index <= size_t_max
            or not valid_string(key, MAX_PLAYLIST_HISTORY_KEY_BYTES, allow_empty=True)
            or original_index in history_indices
        ):
            return None
        history_indices.add(original_index)
        validated_history.append({"original_index": original_index, "key": key})
    return {
        "schema_version": 1,
        "candidate": candidate,
        "current_item": validated_current,
        "queued_items": validated_queued,
        "history_entries": validated_history,
    }


def _expected_playlist_duplicate(request: dict[str, object]) -> dict[str, object]:
    from .store import (
        DuplicateActiveItem,
        DuplicateHistoryEntry,
        PlaylistDuplicateRequest,
        PlaylistIdentity,
        _py_decide_playlist_duplicate,
    )

    def identity(value: dict[str, object]) -> PlaylistIdentity:
        return PlaylistIdentity(
            bvid=value["bvid"],
            aid=value["aid"],
            video_page=value["video_page"],
            selected_audio_pages=tuple(value["selected_audio_pages"]),
        )

    def active(value: dict[str, object]) -> DuplicateActiveItem:
        return DuplicateActiveItem(
            original_index=value["original_index"],
            item_id=value["item_id"],
            identity=identity(value["identity"]),
        )

    current = request["current_item"]
    decision = _py_decide_playlist_duplicate(
        PlaylistDuplicateRequest(
            candidate=identity(request["candidate"]),
            current_item=active(current) if isinstance(current, dict) else None,
            queued_items=tuple(active(value) for value in request["queued_items"]),
            history_entries=tuple(
                DuplicateHistoryEntry(
                    original_index=value["original_index"],
                    key=value["key"],
                )
                for value in request["history_entries"]
            ),
        )
    )
    return {
        "schema_version": 1,
        "identity_key": decision.identity_key,
        "active_duplicate_id": decision.active_duplicate_id,
        "history_duplicate_index": decision.history_duplicate_index,
    }


def _valid_playlist_duplicate_response(
    response: object,
    request: dict[str, object],
) -> bool:
    if not isinstance(response, dict) or set(response) != {
        "schema_version",
        "identity_key",
        "active_duplicate_id",
        "history_duplicate_index",
    }:
        return False
    schema_version = response.get("schema_version")
    response_identity_key = response.get("identity_key")
    active_duplicate_id = response.get("active_duplicate_id")
    history_duplicate_index = response.get("history_duplicate_index")
    active_ids = {
        value["item_id"]
        for value in ([request["current_item"]] if request["current_item"] else [])
        + list(request["queued_items"])
    }
    history_indices = {value["original_index"] for value in request["history_entries"]}
    if (
        isinstance(schema_version, bool)
        or schema_version != 1
        or not isinstance(response_identity_key, str)
        or not response_identity_key
        or active_duplicate_id is not None
        and (not isinstance(active_duplicate_id, str) or active_duplicate_id not in active_ids)
        or history_duplicate_index is not None
        and (
            isinstance(history_duplicate_index, bool)
            or not isinstance(history_duplicate_index, int)
            or history_duplicate_index not in history_indices
        )
    ):
        return False
    candidate = request["candidate"]
    positive_pages = [
        page for page in candidate["selected_audio_pages"] if page > 0
    ]
    audio_suffix = (
        ":a" + "-".join(str(page) for page in positive_pages)
        if positive_pages
        else ""
    )
    prefix = candidate["bvid"] or f"aid:{candidate['aid']}"
    expected_key = f"{prefix}:p{candidate['video_page']}{audio_suffix}"

    def active_identity_key(identity: dict[str, object]) -> str:
        pages = [page for page in identity["selected_audio_pages"] if page > 0]
        suffix = ":a" + "-".join(str(page) for page in pages) if pages else ""
        identity_prefix = identity["bvid"] or f"aid:{identity['aid']}"
        return f"{identity_prefix}:p{identity['video_page']}{suffix}"

    expected_active = None
    active_values = (
        ([request["current_item"]] if request["current_item"] else [])
        + list(request["queued_items"])
    )
    for value in active_values:
        if active_identity_key(value["identity"]) == expected_key:
            expected_active = value["item_id"]
            break
    expected_history = None
    for entry in request["history_entries"]:
        if entry["key"] == expected_key:
            expected_history = entry["original_index"]
            break
    return (
        response_identity_key == expected_key
        and active_duplicate_id == expected_active
        and history_duplicate_index == expected_history
    )


def try_decide_playlist_duplicate(
    request: dict[str, object],
) -> tuple[bool, dict[str, Any] | None]:
    """Call Rust and accept only the exact canonical duplicate decision."""

    validated = _playlist_duplicate_request(request)
    if validated is None:
        return False, None
    response = _call_json_capability(
        "decide_playlist_duplicate", "rust_decide_playlist_duplicate", validated
    )
    if not _valid_playlist_duplicate_response(response, validated):
        return False, None
    assert isinstance(response, dict)
    return True, _strict_equivalence_result(
        "decide_playlist_duplicate",
        response,
        lambda: _expected_playlist_duplicate(validated),
    )
