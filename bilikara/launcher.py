from __future__ import annotations

from datetime import datetime
import os
import sys
import threading
import traceback
from pathlib import Path

DEBUG_LOG_FILE_HANDLE = None


def _env_flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def startup_logging_enabled() -> bool:
    return _env_flag("DEBUG_LOG") or _env_flag("BILIKARA_STARTUP_LOG")


def _fallback_app_home() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "runtime"
    return Path(__file__).resolve().parent.parent


def startup_log_path() -> Path:
    override = os.getenv("DEBUG_LOG_FILE", "").strip()
    if override:
        log_path = Path(override).expanduser()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        return log_path
    log_dir = _fallback_app_home() / "data" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / ("debug.log" if _env_flag("DEBUG_LOG") else "startup.log")


class _TeeStream:
    def __init__(self, primary, log_handle) -> None:
        self.primary = primary
        self.log_handle = log_handle
        self.encoding = getattr(primary, "encoding", "utf-8")
        self.errors = getattr(primary, "errors", "replace")

    def write(self, text) -> int:
        if not isinstance(text, str):
            text = str(text)
        self.primary.write(text)
        self.primary.flush()
        self.log_handle.write(text)
        self.log_handle.flush()
        return len(text)

    def flush(self) -> None:
        self.primary.flush()
        self.log_handle.flush()

    def isatty(self) -> bool:
        return bool(getattr(self.primary, "isatty", lambda: False)())


def _install_debug_log_streams() -> None:
    global DEBUG_LOG_FILE_HANDLE
    if not _env_flag("DEBUG_LOG") or DEBUG_LOG_FILE_HANDLE is not None:
        return
    try:
        log_path = startup_log_path()
        DEBUG_LOG_FILE_HANDLE = log_path.open("a", encoding="utf-8", buffering=1)
        DEBUG_LOG_FILE_HANDLE.write(
            f"\n--- debug log {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ---\n"
        )
        sys.stdout = _TeeStream(sys.stdout, DEBUG_LOG_FILE_HANDLE)
        sys.stderr = _TeeStream(sys.stderr, DEBUG_LOG_FILE_HANDLE)
    except Exception:
        DEBUG_LOG_FILE_HANDLE = None


def append_startup_log(message: str) -> None:
    if not startup_logging_enabled():
        return
    try:
        log_path = startup_log_path()
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(f"[{timestamp}] {message.rstrip()}\n")
    except Exception:
        return


def _install_startup_exception_hooks() -> None:
    if not startup_logging_enabled():
        return
    previous_excepthook = sys.excepthook
    previous_threading_hook = getattr(threading, "excepthook", None)

    def log_main_exception(exc_type, exc_value, exc_traceback):
        append_startup_log(
            "Unhandled exception:\n"
            + "".join(traceback.format_exception(exc_type, exc_value, exc_traceback)).rstrip()
        )
        if previous_excepthook:
            previous_excepthook(exc_type, exc_value, exc_traceback)

    def log_thread_exception(args):
        append_startup_log(
            f"Unhandled thread exception in {args.thread.name}:\n"
            + "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)).rstrip()
        )
        if previous_threading_hook:
            previous_threading_hook(args)

    sys.excepthook = log_main_exception
    if previous_threading_hook is not None:
        threading.excepthook = log_thread_exception


def run_with_startup_logging() -> None:
    _install_debug_log_streams()
    _install_startup_exception_hooks()
    if startup_logging_enabled():
        append_startup_log(
            "Launcher start "
            f"(frozen={getattr(sys, 'frozen', False)}, "
            f"executable={Path(sys.executable).resolve()}, cwd={Path.cwd()}, pid={os.getpid()})"
        )
    try:
        from .config import APP_HOME, ROOT_DIR, STATIC_DIR
        from .server import run
    except Exception:
        append_startup_log("Import failure:\n" + traceback.format_exc().rstrip())
        raise

    if startup_logging_enabled():
        append_startup_log(
            f"Resolved paths (root={ROOT_DIR}, app_home={APP_HOME}, static={STATIC_DIR})"
        )
        append_startup_log("Calling bilikara.server.run()")
    run()
