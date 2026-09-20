"""Observer-only C ABI transport for Rust's configured-source refresh task.

The native worker holds the task lease and finishes repository/Catalog work
without callbacks. This module owns callback lifetimes, never a worker thread.
"""
from __future__ import annotations

import atexit
import ctypes
import itertools
import json
import logging
import threading
from . import rust_runtime

_OBSERVER = ctypes.CFUNCTYPE(None, ctypes.c_uint32, ctypes.c_uint64)
_observers: dict[int, tuple[object, object]] = {}
_observer_lock = threading.Lock()
_identifiers = itertools.count(1)


@_OBSERVER
def _notify(event: int, identifier: int) -> None:
    with _observer_lock:
        callbacks = _observers.get(identifier) if event == 0 else _observers.pop(identifier, None)
    if callbacks is None:
        return
    callback = callbacks[0] if event == 0 else callbacks[1] if event == 1 else None
    if callback is not None:
        try:
            callback()
        except Exception:
            logging.getLogger(__name__).exception("Gatcha refresh observer failed")


def start(request: dict, *, on_start=None, on_done=None) -> bool:
    library = rust_runtime._runtime_lib
    if library is None:
        raise rust_runtime.RustRuntimeUnavailableError("Rust configured-source refresh unavailable")
    try:
        entry = library.bilikara_runtime_gatcha_refresh_start
    except AttributeError as exc:
        raise rust_runtime.RustRuntimeUnavailableError("Rust configured-source refresh unavailable") from exc
    entry.argtypes = [ctypes.c_char_p, _OBSERVER, ctypes.c_uint64]
    entry.restype = ctypes.c_void_p
    identifier = next(_identifiers)
    with _observer_lock:
        _observers[identifier] = (on_start, on_done)
    accepted = False
    try:
        pointer = entry(json.dumps(request, ensure_ascii=False).encode("utf-8"), _notify, identifier)
        if not pointer:
            raise ValueError("missing refresh response")
        try:
            response = json.loads(ctypes.string_at(pointer))
        finally:
            library.bilikara_runtime_free_string(pointer)
        if not isinstance(response, dict) or response.get("schema_version") != 1:
            raise ValueError("invalid refresh response")
        if response.get("status") != "ok":
            error = response.get("error") or {}
            raise rust_runtime.RustRuntimeServiceError(
                str(error.get("kind") or "refresh_failed"),
                str(error.get("message") or "Rust refresh failed"), response=response,
            )
        result = response.get("result")
        if not isinstance(result, dict) or type(result.get("started")) is not bool:
            raise ValueError("invalid refresh admission")
        accepted = result["started"]
        return accepted
    finally:
        if not accepted:
            with _observer_lock:
                _observers.pop(identifier, None)


def new_owner() -> int:
    library = rust_runtime._runtime_lib
    if library is None or not hasattr(library, "bilikara_runtime_gatcha_refresh_owner"):
        raise rust_runtime.RustRuntimeUnavailableError("Rust configured-source refresh unavailable")
    entry = library.bilikara_runtime_gatcha_refresh_owner
    entry.argtypes = []
    entry.restype = ctypes.c_uint64
    return int(entry())


def stop(owner: int = 0) -> None:
    library = rust_runtime._runtime_lib
    if library is not None and hasattr(library, "bilikara_runtime_gatcha_refresh_stop"):
        entry = library.bilikara_runtime_gatcha_refresh_stop
        entry.argtypes = [ctypes.c_uint64]
        entry.restype = None
        entry(owner)


atexit.register(stop)
