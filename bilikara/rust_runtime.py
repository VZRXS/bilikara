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


class RustMediaError(RuntimeError):
    def __init__(self, kind: str, message: str, *, response: dict[str, Any]) -> None:
        super().__init__(message)
        self.kind = kind
        self.response = response


class RustStatusServiceError(RuntimeError):
    pass


class RustRuntimeServiceError(RuntimeError):
    def __init__(self, kind: str, message: str, *, response: dict[str, Any]) -> None:
        super().__init__(message)
        self.kind = kind
        self.response = response


def _runtime_library_name() -> str:
    system = platform.system()
    if system == "Windows":
        return "bilikara_runtime.dll"
    if system == "Darwin":
        return "libbilikara_runtime.dylib"
    return "libbilikara_runtime.so"


def _runtime_library_candidates() -> list[Path]:
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
    return candidates


def _get_runtime_lib_path() -> Path | None:
    candidates = _runtime_library_candidates()
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _load_runtime_library(path: Path | None):
    details: dict[str, Any] = {
        "stage": "locate_library" if path is None else "load_library",
        "selected_path": str(path or ""),
        "exception_type": "",
        "exception_message": "",
        "actual_abi_version": None,
    }
    if path is None:
        return None, "Rust runtime library not found", details
    try:
        library = ctypes.CDLL(str(path))
        details["stage"] = "resolve_symbols"
        library.bilikara_runtime_abi_version.argtypes = []
        library.bilikara_runtime_abi_version.restype = ctypes.c_uint32
        actual_abi_version = int(library.bilikara_runtime_abi_version())
        details["actual_abi_version"] = actual_abi_version
        if actual_abi_version != EXPECTED_RUNTIME_ABI_VERSION:
            details["stage"] = "validate_abi"
            return (
                None,
                "Rust runtime ABI version mismatch",
                details,
            )
        library.bilikara_runtime_download.argtypes = [
            ctypes.c_char_p,
            _PROGRESS_CALLBACK,
            ctypes.c_void_p,
        ]
        library.bilikara_runtime_download.restype = ctypes.c_void_p
        library.bilikara_runtime_media_probe.argtypes = [ctypes.c_char_p]
        library.bilikara_runtime_media_probe.restype = ctypes.c_void_p
        library.bilikara_runtime_media_normalize.argtypes = [ctypes.c_char_p]
        library.bilikara_runtime_media_normalize.restype = ctypes.c_void_p
        library.bilikara_runtime_status_service.argtypes = [ctypes.c_char_p]
        library.bilikara_runtime_status_service.restype = ctypes.c_void_p
        library.bilikara_runtime_service.argtypes = [ctypes.c_char_p]
        library.bilikara_runtime_service.restype = ctypes.c_void_p
        library.bilikara_runtime_free_string.argtypes = [ctypes.c_void_p]
        library.bilikara_runtime_free_string.restype = None
        details["stage"] = "ready"
        return library, "", details
    except (AttributeError, OSError, TypeError, ValueError) as exc:
        details["exception_type"] = type(exc).__name__
        details["exception_message"] = str(exc)
        return None, f"Rust runtime load failed: {type(exc).__name__}", details


_runtime_lib_candidates = _runtime_library_candidates()
_runtime_python_executable = str(Path(sys.executable).resolve())
_runtime_process_bits = ctypes.sizeof(ctypes.c_void_p) * 8
_runtime_machine = platform.machine()
_runtime_frozen_bundle = bool(getattr(sys, "frozen", False))
_runtime_lib_path = next(
    (candidate for candidate in _runtime_lib_candidates if candidate.is_file()),
    None,
)
_runtime_lib, _runtime_error, _runtime_load_diagnostics = _load_runtime_library(
    _runtime_lib_path
)


def runtime_status() -> dict[str, Any]:
    candidates = []
    for path in _runtime_lib_candidates:
        try:
            exists = path.is_file()
        except OSError:
            exists = False
        candidates.append({"path": str(path), "exists": exists})
    return {
        "loaded": _runtime_lib is not None,
        "path": str(_runtime_lib_path or ""),
        "error": _runtime_error,
        "abi_version": EXPECTED_RUNTIME_ABI_VERSION if _runtime_lib is not None else None,
        "expected_abi_version": EXPECTED_RUNTIME_ABI_VERSION,
        "load_diagnostics": {
            **_runtime_load_diagnostics,
            "candidate_paths": candidates,
            "process_bits": _runtime_process_bits,
            "machine": _runtime_machine,
            "python_executable": _runtime_python_executable,
            "frozen_bundle": _runtime_frozen_bundle,
        },
        "capabilities": {
            "http_download": _runtime_lib is not None,
            "media_backend": _runtime_lib is not None,
            "status_service": _runtime_lib is not None,
            "json_http": _runtime_lib is not None,
            "networking": _runtime_lib is not None,
            "update_installer": _runtime_lib is not None,
            "diagnostics": _runtime_lib is not None,
        },
    }


def http_download_available() -> bool:
    return _runtime_lib is not None


def media_backend_available() -> bool:
    return _runtime_lib is not None


def status_service_available() -> bool:
    return _runtime_lib is not None


def json_http_request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    payload: Any = None,
    timeout: float = 12.0,
) -> Any:
    request: dict[str, Any] = {
        "method": str(method),
        "url": str(url),
        "headers": [
            {"name": str(name), "value": str(value)}
            for name, value in (headers or {}).items()
        ],
        "timeout_ms": max(100, int(float(timeout) * 1000)),
    }
    if payload is not None:
        request["payload"] = payload
    result = _call_runtime_service("json_http", request)
    if "payload" not in result:
        raise RustRuntimeServiceError(
            "invalid_response",
            "Rust JSON HTTP service returned no payload",
            response=result,
        )
    return result["payload"]


def detect_lan_ipv4_addresses(
    *,
    platform_name: str = "",
    candidates: list[dict[str, Any]] | None = None,
    route_sources: list[str] | None = None,
) -> list[str]:
    request: dict[str, Any] = {"platform_name": str(platform_name)}
    if candidates is not None:
        request["candidates"] = candidates
    if route_sources is not None:
        request["route_sources"] = [str(value) for value in route_sources]
    result = _call_runtime_service("network_addresses", request)
    addresses = result.get("addresses")
    if not isinstance(addresses, list) or not all(
        isinstance(address, str) for address in addresses
    ):
        raise RustRuntimeServiceError(
            "invalid_response",
            "Rust networking service returned invalid addresses",
            response=result,
        )
    return addresses


def prepare_update_install(request: dict[str, Any]) -> list[str]:
    result = _call_runtime_service("prepare_update", request)
    command = result.get("command")
    if not isinstance(command, list) or not command or not all(
        isinstance(value, str) and value for value in command
    ):
        raise RustRuntimeServiceError(
            "invalid_response",
            "Rust update installer returned an invalid helper command",
            response=result,
        )
    return command


def launch_update_helper(command: list[str]) -> None:
    result = _call_runtime_service(
        "launch_update_helper", {"command": [str(value) for value in command]}
    )
    if result.get("launched") is not True:
        raise RustRuntimeServiceError(
            "invalid_response",
            "Rust update installer did not launch the helper",
            response=result,
        )


def build_diagnostic_artifact(request: dict[str, Any]) -> dict[str, Any]:
    result = _call_runtime_service("build_diagnostics", request)
    if not isinstance(result.get("markdown"), str):
        raise RustRuntimeServiceError(
            "invalid_response",
            "Rust diagnostics service returned invalid markdown",
            response=result,
        )
    if not isinstance(result.get("files"), dict) or not isinstance(
        result.get("zip_base64"), str
    ):
        raise RustRuntimeServiceError(
            "invalid_response",
            "Rust diagnostics service returned invalid files",
            response=result,
        )
    return result


def probe_connectivity(
    targets: dict[str, str],
    *,
    timeout: float = 5.0,
    local_usernames: list[str] | None = None,
) -> dict[str, Any]:
    result = _call_runtime_service(
        "probe_connectivity",
        {
            "targets": {str(name): str(url) for name, url in targets.items()},
            "timeout_ms": max(100, int(float(timeout) * 1000)),
            "local_usernames": [str(value) for value in (local_usernames or [])],
        },
    )
    return result


def gatcha_task_snapshot() -> dict[str, Any]:
    return _validated_gatcha_snapshot(
        _call_status_service({"command": "gacha_snapshot"})
    )


def try_begin_gatcha_refresh(
    *,
    busy_message: str,
    task: dict[str, Any] | None = None,
) -> bool:
    request: dict[str, Any] = {
        "command": "gacha_try_begin",
        "busy_message": str(busy_message),
    }
    if task is not None:
        request["task"] = _gatcha_task_update(task)
    result = _call_status_service(request)
    if not isinstance(result.get("started"), bool):
        raise RustStatusServiceError("Rust status service returned an invalid lease result")
    _validated_gatcha_snapshot(result.get("snapshot"))
    return bool(result["started"])


def set_gatcha_task_status(
    status: str,
    *,
    message: str = "",
    error: str = "",
    result: dict[str, Any] | None = None,
    blocking: bool = True,
    busy_message: str = "",
) -> dict[str, Any]:
    task = _gatcha_task_update(
        {
            "status": status,
            "message": message,
            "error": error,
            "result": result,
            "blocking": blocking,
        }
    )
    return _validated_gatcha_snapshot(
        _call_status_service(
            {
                "command": "gacha_set",
                "task": task,
                "busy_message": str(busy_message),
            }
        )
    )


def release_gatcha_refresh() -> dict[str, Any]:
    return _validated_gatcha_snapshot(
        _call_status_service({"command": "gacha_release"})
    )


def reset_gatcha_status_service() -> dict[str, Any]:
    return _validated_gatcha_snapshot(
        _call_status_service({"command": "gacha_reset"})
    )


def begin_bilibili_login(*, message: str) -> int:
    result = _call_status_service(
        {"command": "bilibili_begin", "message": str(message)}
    )
    generation = result.get("generation")
    if not isinstance(generation, int) or isinstance(generation, bool) or generation <= 0:
        raise RustStatusServiceError("Rust status service returned an invalid login generation")
    return generation


def set_bilibili_login_status(
    state: str,
    *,
    message: str = "",
    qr_image: str = "",
    generation: int | None = None,
) -> bool:
    request: dict[str, Any] = {
        "command": "bilibili_set",
        "state": str(state),
        "message": str(message),
        "qr_image": str(qr_image),
    }
    if generation is not None:
        request["generation"] = int(generation)
    result = _call_status_service(request)
    if not isinstance(result.get("applied"), bool):
        raise RustStatusServiceError("Rust status service returned an invalid update result")
    return bool(result["applied"])


def bilibili_login_snapshot(
    *, logged_in: bool, data_exists: bool, data_path: Path
) -> dict[str, Any]:
    result = _call_status_service(
        {
            "command": "bilibili_snapshot",
            "facts": {
                "logged_in": bool(logged_in),
                "data_exists": bool(data_exists),
                "data_path": str(data_path),
            },
        }
    )
    required = {"logged_in", "state", "message", "data_path", "qr_image"}
    if not isinstance(result, dict) or not required.issubset(result):
        raise RustStatusServiceError("Rust status service returned an invalid login snapshot")
    if not isinstance(result.get("logged_in"), bool):
        raise RustStatusServiceError("Rust status service returned an invalid login flag")
    return {
        "logged_in": result["logged_in"],
        "state": str(result["state"]),
        "message": str(result["message"]),
        "data_path": str(result["data_path"]),
        "qr_image": str(result["qr_image"]),
    }


def reset_bilibili_login_status() -> None:
    result = _call_status_service({"command": "bilibili_reset"})
    if result.get("reset") is not True:
        raise RustStatusServiceError("Rust status service did not reset login state")


def _call_status_service(request: dict[str, Any]) -> dict[str, Any]:
    if _runtime_lib is None:
        raise RustRuntimeUnavailableError(_runtime_error or "Rust runtime is unavailable")
    payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pointer = _runtime_lib.bilikara_runtime_status_service(payload)
    if not pointer:
        raise RustStatusServiceError("Rust status service returned no response")
    try:
        response_bytes = ctypes.string_at(pointer)
    finally:
        _runtime_lib.bilikara_runtime_free_string(pointer)
    try:
        response = json.loads(response_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RustStatusServiceError("Rust status service returned malformed JSON") from exc
    if (
        not isinstance(response, dict)
        or response.get("schema_version") != 1
        or response.get("status") != "completed"
        or not isinstance(response.get("result"), dict)
    ):
        raise RustStatusServiceError("Rust status service returned an invalid response")
    return response["result"]


def _call_runtime_service(service: str, request: dict[str, Any]) -> dict[str, Any]:
    if _runtime_lib is None:
        raise RustRuntimeUnavailableError(_runtime_error or "Rust runtime is unavailable")
    payload = json.dumps(
        {"service": str(service), "request": request},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    pointer = _runtime_lib.bilikara_runtime_service(payload)
    if not pointer:
        raise RustRuntimeServiceError(
            "no_response", "Rust runtime service returned no response", response={}
        )
    try:
        response_bytes = ctypes.string_at(pointer)
    finally:
        _runtime_lib.bilikara_runtime_free_string(pointer)
    try:
        response = json.loads(response_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RustRuntimeServiceError(
            "invalid_json", "Rust runtime service returned malformed JSON", response={}
        ) from exc
    if not isinstance(response, dict) or response.get("schema_version") != 1:
        raise RustRuntimeServiceError(
            "invalid_response",
            "Rust runtime service returned an invalid response",
            response=response if isinstance(response, dict) else {},
        )
    if response.get("status") != "completed":
        error = response.get("error") if isinstance(response.get("error"), dict) else {}
        raise RustRuntimeServiceError(
            str(error.get("kind") or "service_failed"),
            str(error.get("message") or "Rust runtime service failed"),
            response=response,
        )
    result = response.get("result")
    if not isinstance(result, dict):
        raise RustRuntimeServiceError(
            "invalid_response",
            "Rust runtime service returned an invalid result",
            response=response,
        )
    return result


def _gatcha_task_update(task: dict[str, Any]) -> dict[str, Any]:
    status = str(task.get("status") or "").strip().lower()
    if status not in {"idle", "running", "success", "partial", "failed"}:
        raise ValueError(f"unsupported gatcha task status: {status}")
    result = task.get("result")
    if result is not None and not isinstance(result, dict):
        raise ValueError("gatcha task result must be an object or null")
    return {
        "status": status,
        "message": str(task.get("message") or ""),
        "error": str(task.get("error") or ""),
        "result": result,
        "blocking": bool(task.get("blocking", True)),
    }


def _validated_gatcha_snapshot(snapshot: object) -> dict[str, Any]:
    required = {
        "busy",
        "background_busy",
        "blocking",
        "message",
        "last_status",
        "last_message",
        "last_error",
        "last_updated_at",
        "last_result",
    }
    if not isinstance(snapshot, dict) or not required.issubset(snapshot):
        raise RustStatusServiceError("Rust status service returned an invalid gatcha snapshot")
    if any(
        not isinstance(snapshot.get(key), bool)
        for key in ("busy", "background_busy", "blocking")
    ):
        raise RustStatusServiceError("Rust status service returned invalid gatcha flags")
    try:
        updated_at = float(snapshot.get("last_updated_at") or 0)
    except (TypeError, ValueError) as exc:
        raise RustStatusServiceError("Rust status service returned an invalid timestamp") from exc
    last_result = snapshot.get("last_result")
    if last_result is not None and not isinstance(last_result, dict):
        raise RustStatusServiceError("Rust status service returned an invalid task result")
    return {
        "busy": snapshot["busy"],
        "background_busy": snapshot["background_busy"],
        "blocking": snapshot["blocking"],
        "message": str(snapshot["message"]),
        "last_status": str(snapshot["last_status"]),
        "last_message": str(snapshot["last_message"]),
        "last_error": str(snapshot["last_error"]),
        "last_updated_at": updated_at,
        "last_result": last_result,
    }


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


def probe_media(*, source: Path, expected_kind: str) -> dict[str, Any]:
    request = {
        "schema_version": 1,
        "source": str(source.resolve()),
        "expected_kind": _normalized_media_kind(expected_kind),
    }
    result = _call_media_api("bilikara_runtime_media_probe", request)
    _validate_media_probe(result, expected_path=source, expected_kind=expected_kind)
    return result


def normalize_media(
    *, source: Path, destination: Path, expected_kind: str
) -> dict[str, Any]:
    request = {
        "schema_version": 1,
        "source": str(source.resolve()),
        "destination": str(destination.resolve()),
        "expected_kind": _normalized_media_kind(expected_kind),
    }
    result = _call_media_api("bilikara_runtime_media_normalize", request)
    source_result = result.get("source")
    output_result = result.get("output")
    if not isinstance(source_result, dict) or not isinstance(output_result, dict):
        raise RustMediaError(
            "invalid_response",
            "Rust media backend omitted normalization metadata",
            response=result,
        )
    _validate_media_probe(source_result, expected_path=source, expected_kind=expected_kind)
    _validate_media_probe(output_result, expected_path=destination, expected_kind=expected_kind)
    if not bool(output_result.get("fast_start")):
        raise RustMediaError(
            "invalid_response",
            "Rust media backend returned a non-fast-start output",
            response=result,
        )
    return result


def _normalized_media_kind(expected_kind: str) -> str:
    value = str(expected_kind or "").strip().lower()
    if value not in {"video", "audio"}:
        raise ValueError("expected_kind must be video or audio")
    return value


def _call_media_api(symbol: str, request: dict[str, Any]) -> dict[str, Any]:
    if _runtime_lib is None:
        raise RustRuntimeUnavailableError(_runtime_error or "Rust runtime is unavailable")
    payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    function = getattr(_runtime_lib, symbol)
    pointer = function(payload)
    if not pointer:
        raise RustMediaError(
            "invalid_response",
            "Rust media backend returned no response",
            response={},
        )
    try:
        response_bytes = ctypes.string_at(pointer)
    finally:
        _runtime_lib.bilikara_runtime_free_string(pointer)
    try:
        response = json.loads(response_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RustMediaError(
            "invalid_response",
            "Rust media backend returned malformed JSON",
            response={},
        ) from exc
    if not isinstance(response, dict) or response.get("schema_version") != 1:
        raise RustMediaError(
            "invalid_response",
            "Rust media backend returned an unsupported response",
            response={},
        )
    if response.get("status") == "completed":
        result = response.get("result")
        if isinstance(result, dict):
            return result
        raise RustMediaError(
            "invalid_response",
            "Rust media backend omitted its result",
            response=response,
        )
    error = response.get("error")
    error = error if isinstance(error, dict) else {}
    raise RustMediaError(
        str(error.get("kind") or "unknown"),
        str(error.get("message") or "Rust media operation failed"),
        response=response,
    )


def _validate_media_probe(
    probe: dict[str, Any], *, expected_path: Path, expected_kind: str
) -> None:
    try:
        result_path = Path(str(probe.get("path") or "")).resolve()
        duration = float(probe.get("duration_seconds") or 0)
        sample_count = int(probe.get("sample_count") or 0)
        sample_bytes = int(probe.get("sample_bytes") or 0)
        file_bytes = int(probe.get("file_bytes") or 0)
    except (OSError, TypeError, ValueError) as exc:
        raise RustMediaError(
            "invalid_response",
            "Rust media backend returned invalid probe metadata",
            response=probe,
        ) from exc
    if (
        result_path != expected_path.resolve()
        or str(probe.get("kind") or "") != _normalized_media_kind(expected_kind)
        or not str(probe.get("codec") or "")
        or duration <= 0
        or sample_count <= 0
        or sample_bytes <= 0
        or file_bytes <= 0
    ):
        raise RustMediaError(
            "invalid_response",
            "Rust media backend returned invalid probe metadata",
            response=probe,
        )
