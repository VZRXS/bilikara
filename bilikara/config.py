from __future__ import annotations

import ipaddress
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

APP_NAME = "bilikara"
WINDOWS_VIRTUAL_ADAPTER_KEYWORDS = (
    "hyper-v",
    "vethernet",
    "vmware",
    "virtualbox",
    "wsl",
    "docker",
    "tailscale",
    "zerotier",
    "singbox",
    "sing-box",
    "singbox_tun",
    "sing-tun",
    "mihomo",
    "meta",
    "clash",
    "v2rayn",
    "nekoray",
    "hiddify",
    "tun2socks",
    "wintun",
    "loopback",
    "bluetooth",
    "vmess",
    "vless",
    "trojan",
    "shadowsocks",
)


def _looks_like_windows_virtual_adapter(*labels: object) -> bool:
    text = " ".join(str(label or "") for label in labels).lower()
    return any(keyword in text for keyword in WINDOWS_VIRTUAL_ADAPTER_KEYWORDS)


def _pick_windows_physical_host(adapter_configs: object) -> str | None:
    configs = adapter_configs if isinstance(adapter_configs, list) else [adapter_configs]
    preferred: list[str] = []
    fallback: list[str] = []
    seen: set[str] = set()

    for config in configs:
        if not isinstance(config, dict):
            continue

        alias = config.get("InterfaceAlias")
        description = config.get("InterfaceDescription")
        if _looks_like_windows_virtual_adapter(alias, description):
            continue

        gateway = config.get("IPv4DefaultGateway")
        gateway_entries = gateway if isinstance(gateway, list) else [gateway] if gateway else []
        has_default_gateway = any(isinstance(entry, dict) and entry.get("NextHop") for entry in gateway_entries)

        addresses = config.get("IPv4Address")
        address_entries = addresses if isinstance(addresses, list) else [addresses] if addresses else []
        for entry in address_entries:
            if not isinstance(entry, dict):
                continue
            ip = str(entry.get("IPAddress") or "").strip()
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
                if has_default_gateway:
                    preferred.append(ip)
                else:
                    fallback.append(ip)

    if preferred:
        return preferred[0]
    if fallback:
        return fallback[0]
    return None


def _detect_windows_physical_host() -> str | None:
    command = (
        "Get-NetIPConfiguration | "
        "Select-Object InterfaceAlias,InterfaceDescription,IPv4Address,IPv4DefaultGateway | "
        "ConvertTo-Json -Depth 6 -Compress"
    )
    try:
        process = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=8,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    if process.returncode != 0:
        return None

    raw = (process.stdout or "").strip()
    if not raw:
        return None

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None

    return _pick_windows_physical_host(payload)


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

    # Legacy Windows packaged strategy:
    # keep the broader heuristic that scans IPv4 candidates.
    #
    # if getattr(sys, "frozen", False) and os.name == "nt":
    #     return _detect_windows_bind_host()

    # Current Windows packaged strategy:
    # prefer a host from the default physical adapter, and only fall back to
    # the legacy broad IPv4 scan when that selection cannot determine a good
    # candidate.
    if getattr(sys, "frozen", False) and os.name == "nt":
        physical_host = _detect_windows_physical_host()
        if physical_host:
            return physical_host
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
APP_VERSION_FILE = ROOT_DIR / "APP_VERSION"
DATA_DIR = APP_HOME / "data"
CACHE_DIR = DATA_DIR / "cache"
LOG_DIR = DATA_DIR / "logs"
PLAYED_SESSION_DIR = DATA_DIR / "played_sessions"
STATE_FILE = DATA_DIR / "state.json"
BACKUP_FILE = DATA_DIR / "playlist_backup.json"
CACHE_POLICY_FILE = DATA_DIR / "cache_policy.json"
TOOLS_DIR = APP_HOME / "tools"
VENDOR_DIR = ROOT_DIR / "vendor"
INTERNAL_VENDOR_DIR = ROOT_DIR / "_internal" / "vendor"
BB_DOWN_DIR = TOOLS_DIR / "bbdown"
FFMPEG_TOOLS_DIR = BB_DOWN_DIR
FFMPEG_RUNTIME_PATH = FFMPEG_TOOLS_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
FFPROBE_RUNTIME_PATH = FFMPEG_TOOLS_DIR / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
FFMPEG_BUNDLED_PATH = VENDOR_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
FFPROBE_BUNDLED_PATH = VENDOR_DIR / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
BB_DOWN_VERSION_FILE = BB_DOWN_DIR / "VERSION"
GATCHA_UIDS = ["3145040","671767","33091201","3494356589742209","44627483","8474818","10077309","74089392","1879151","87101327","99061404","602998","1159885664","215040","31624333","21129450","2625848","29955371","3014315","80148988"]
GATCHA_KEYWORDS = ["卡拉", "カラ", "投屏","KTV","纯K"]
USER_VIDEO_API = "https://api.bilibili.com/x/space/wbi/arc/search?mid={mid}&ps=50&tid=0&pn=1&order=pubdate"

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
APP_RELEASE_API = "https://api.github.com/repos/VZRXS/bilikara/releases/latest"
APP_RELEASES_URL = "https://github.com/VZRXS/bilikara/releases"


def _detect_app_version() -> str:
    override = os.getenv("BILIKARA_VERSION", "").strip()
    if override:
        return override
    if not getattr(sys, "frozen", False):
        try:
            process = subprocess.run(
                ["git", "describe", "--tags", "--always", "--dirty"],
                cwd=ROOT_DIR,
                capture_output=True,
                text=True,
                errors="replace",
                check=False,
                timeout=2,
            )
        except (OSError, subprocess.SubprocessError):
            process = None
        if process and process.returncode == 0:
            detected = (process.stdout or "").strip()
            if detected:
                return detected
    try:
        version = APP_VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        version = ""
    if version:
        return version
    return "dev"


APP_VERSION = _detect_app_version()


def ensure_directories() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PLAYED_SESSION_DIR.mkdir(parents=True, exist_ok=True)
    BB_DOWN_DIR.mkdir(parents=True, exist_ok=True)
