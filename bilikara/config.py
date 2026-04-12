from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "bilikara"


def _resource_root() -> Path:
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _frozen_runtime_home() -> Path:
    return Path(sys.executable).resolve().parent / "runtime"


def _default_app_home() -> Path:
    override = os.getenv("BILIKARA_HOME", "").strip()
    if override:
        return Path(override).expanduser()

    if getattr(sys, "frozen", False):
        return _frozen_runtime_home()

    return _resource_root()


ROOT_DIR = _resource_root()
APP_HOME = _default_app_home()
STATIC_DIR = ROOT_DIR / "static"
DATA_DIR = APP_HOME / "data"
CACHE_DIR = DATA_DIR / "cache"
LOG_DIR = DATA_DIR / "logs"
STATE_FILE = DATA_DIR / "state.json"
BACKUP_FILE = DATA_DIR / "playlist_backup.json"
TOOLS_DIR = APP_HOME / "tools"
VENDOR_DIR = ROOT_DIR / "vendor"
INTERNAL_VENDOR_DIR = ROOT_DIR / "_internal" / "vendor"
BB_DOWN_DIR = TOOLS_DIR / "bbdown"
FFMPEG_TOOLS_DIR = BB_DOWN_DIR
FFMPEG_RUNTIME_PATH = FFMPEG_TOOLS_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
FFPROBE_RUNTIME_PATH = FFMPEG_TOOLS_DIR / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
FFMPEG_BUNDLED_PATH = VENDOR_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
BB_DOWN_VERSION_FILE = BB_DOWN_DIR / "VERSION"

HOST = os.getenv("BILIKARA_HOST", "0.0.0.0")
PORT = int(os.getenv("BILIKARA_PORT", "8080"))
MAX_CACHE_ITEMS = max(0, int(os.getenv("BILIKARA_MAX_CACHE_ITEMS", "3")))
COOKIE = os.getenv("BILIKARA_BILIBILI_COOKIE", "").strip()
BB_DOWN_PATH_OVERRIDE = os.getenv("BB_DOWN_PATH", "").strip()
FFMPEG_PATH_OVERRIDE = os.getenv("FFMPEG_PATH", "").strip()

BILIBILI_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}

BB_DOWN_RELEASE_API = "https://api.github.com/repos/nilaoda/BBDown/releases/latest"


def ensure_directories() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    BB_DOWN_DIR.mkdir(parents=True, exist_ok=True)
