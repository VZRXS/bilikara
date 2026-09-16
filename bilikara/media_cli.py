"""Bundle policy: deny FFmpeg/ffprobe processes, retain in-process libav.

Frozen bundles always enforce this policy; an environment variable cannot undo
it. Source tests opt in with BILIKARA_DISABLE_MEDIA_CLI=1. This module owns only
Host subprocess admission, not media interpretation or AppState policy.
"""
from __future__ import annotations

import os
import shlex
import sys

DISABLED = bool(getattr(sys, "frozen", False)) or os.environ.get(
    "BILIKARA_DISABLE_MEDIA_CLI", ""
).strip().lower() in {"1", "true", "yes", "on"}
MESSAGE = "当前构建不支持外部媒体 CLI（FFmpeg/ffprobe）；请使用 Rust Native。"


class MediaCliDisabledError(RuntimeError):
    pass


def require_media_cli(tool: str = "ffmpeg") -> None:
    name = os.fsdecode(tool).replace("\\", "/").rsplit("/", 1)[-1].lower().removesuffix(".exe")
    if DISABLED and name in {"ffmpeg", "ffprobe"}:
        raise MediaCliDisabledError(MESSAGE)


def _audit(event: str, args: tuple) -> None:
    if event != "subprocess.Popen":
        return
    executable = args[0]
    if executable is None:
        # Windows Popen normally reports executable=None and a quoted command
        # line; POSIX reports the executable separately.
        command = args[1]
        if isinstance(command, (list, tuple)):
            executable = command[0]
        else:
            parts = shlex.split(os.fsdecode(command), posix=False)
            executable = parts[0].strip('"') if parts else ""
    executable = os.fsdecode(executable).replace("\\", "/").rsplit("/", 1)[-1].lower()
    if executable.removesuffix(".exe") in {"ffmpeg", "ffprobe"}:
        raise MediaCliDisabledError(MESSAGE)


if DISABLED:
    # Defense in depth for direct version probes and delegated process entry.
    # Explicit Host guards also block renamed/override paths before preparation.
    sys.addaudithook(_audit)
