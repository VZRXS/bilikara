from __future__ import annotations

from datetime import datetime
import os
import sys
import threading
import traceback
from pathlib import Path


def startup_logging_enabled() -> bool:
    return os.getenv("BILIKARA_STARTUP_LOG", "").strip().lower() in {"1", "true", "yes", "on"}


def _fallback_app_home() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "runtime"
    return Path(__file__).resolve().parent.parent


def startup_log_path() -> Path:
    log_dir = _fallback_app_home() / "data" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "startup.log"


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
