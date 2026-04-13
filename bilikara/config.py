from __future__ import annotations

import ipaddress
import os
import socket
import sys
from pathlib import Path

APP_NAME = "bilikara"


def _detect_windows_bind_host() -> str:
    candidates: list[str] = []

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("1.1.1.1", 80))
            candidates.append(sock.getsockname()[0])
    except OSError:
        pass

    try:
        for entry in socket.getaddrinfo(socket.gethostname(), None, family=socket.AF_INET):
            candidates.append(entry[4][0])
    except OSError:
        pass

    preferred: list[str] = []
    fallback: list[str] = []
    seen: set[str] = set()
    for ip in candidates:
        if not ip or ip in seen:
            continue
        seen.add(ip)
        try:
            address = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if address.version != 4 or address.is_loopback or address.is_unspecified:
            continue
        if address.is_private and not address.is_link_local:
            preferred.append(ip)
        elif not address.is_multicast:
            fallback.append(ip)

    if preferred:
        return preferred[0]
    if fallback:
        return fallback[0]
    return "0.0.0.0"


def _default_host() -> str:
    override = os.getenv("BILIKARA_HOST", "").strip()
    if override:
        return override

    # Windows packaged apps are more likely to hit firewall/loopback friction
    # when binding to 0.0.0.0 on first launch. Prefer a concrete LAN IPv4 there
    # when available, and fall back to localhost.
    if getattr(sys, "frozen", False) and os.name == "nt":
        return _detect_windows_bind_host()

    return "0.0.0.0"


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
PLAYED_SESSION_DIR = DATA_DIR / "played_sessions"
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

HOST = _default_host()
PORT = int(os.getenv("BILIKARA_PORT", "8080"))
MAX_CACHE_ITEMS = max(0, int(os.getenv("BILIKARA_MAX_CACHE_ITEMS", "3")))
# MAX_CACHE_ITEMS = min(max(0, int(os.getenv("BILIKARA_MAX_CACHE_ITEMS", "3"))), 5)  # force max=5
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
    PLAYED_SESSION_DIR.mkdir(parents=True, exist_ok=True)
    BB_DOWN_DIR.mkdir(parents=True, exist_ok=True)
