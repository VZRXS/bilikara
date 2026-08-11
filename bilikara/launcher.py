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
        if sys.platform == "darwin":
            return Path("~/Library/Application Support/bilikara").expanduser()
        return Path(sys.executable).resolve().parent / "runtime"
    return Path(__file__).resolve().parent.parent


def _ensure_std_streams() -> None:
    if sys.stdout is None:
        try:
            sys.stdout = os.fdopen(1, "w", encoding="utf-8", buffering=1)
        except Exception:
            pass
    if sys.stderr is None:
        try:
            sys.stderr = os.fdopen(2, "w", encoding="utf-8", buffering=1)
        except Exception:
            pass


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
        self.encoding = getattr(primary, "encoding", "utf-8") if primary is not None else "utf-8"
        self.errors = getattr(primary, "errors", "replace") if primary is not None else "replace"

    def write(self, text) -> int:
        if not isinstance(text, str):
            text = str(text)
        if self.primary is not None:
            try:
                self.primary.write(text)
                self.primary.flush()
            except Exception:
                pass
        self.log_handle.write(text)
        self.log_handle.flush()
        return len(text)

    def flush(self) -> None:
        if self.primary is not None:
            try:
                self.primary.flush()
            except Exception:
                pass
        self.log_handle.flush()

    def isatty(self) -> bool:
        if self.primary is None:
            return False
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
    import argparse
    parser = argparse.ArgumentParser(description="bilikara")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a system browser")
    parser.add_argument("--headless", action="store_true", help="Do not auto-exit when browser closes")
    parser.add_argument("--host", type=str, default=None, help="Bind host")
    parser.add_argument("--port", type=int, default=None, help="Bind port")
    parser.add_argument("--https-smoke", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--tool-smoke",
        choices=("bbdown", "aria2c"),
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    _ensure_std_streams()
    _install_debug_log_streams()
    _install_startup_exception_hooks()
    if startup_logging_enabled():
        append_startup_log(
            "Launcher start "
            f"(frozen={getattr(sys, 'frozen', False)}, "
            f"executable={Path(sys.executable).resolve()}, cwd={Path.cwd()}, pid={os.getpid()}, args={sys.argv})"
        )
    try:
        from .https_trust import initialize_https_trust, packaged_https_smoke_json

        trust_status = initialize_https_trust()
        if startup_logging_enabled():
            append_startup_log(
                "HTTPS trust initialized "
                f"(backend={trust_status.backend}, verify_mode=CERT_REQUIRED, "
                f"check_hostname={trust_status.check_hostname})"
            )
        if args.https_smoke:
            print(packaged_https_smoke_json(), flush=True)
            return
        if args.tool_smoke:
            from .tool_smoke import packaged_tool_smoke_json

            print(packaged_tool_smoke_json(args.tool_smoke), flush=True)
            return

        from .config import APP_HOME, ROOT_DIR, STATIC_DIR
        from .server import run
    except Exception:
        append_startup_log(
            "Import or HTTPS initialization failure:\n" + traceback.format_exc().rstrip()
        )
        raise

    if startup_logging_enabled():
        append_startup_log(
            f"Resolved paths (root={ROOT_DIR}, app_home={APP_HOME}, static={STATIC_DIR})"
        )
        append_startup_log("Calling bilikara.server.run()")

    run_kwargs = {}
    if args.no_browser:
        run_kwargs["open_browser"] = False
    if args.headless:
        run_kwargs["shutdown_on_last_client"] = False
    if args.host is not None:
        run_kwargs["host"] = args.host
    if args.port is not None:
        run_kwargs["port"] = args.port
        if args.port == 0:
            run_kwargs["auto_select_port"] = False

    run(**run_kwargs)
