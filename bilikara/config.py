from __future__ import annotations

import ipaddress
import os
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
    try:
        from .rust_runtime import detect_lan_ipv4_addresses

        addresses = detect_lan_ipv4_addresses(platform_name="win32")
    except Exception:  # noqa: BLE001
        return None
    return addresses[0] if addresses else None


def _detect_windows_bind_host() -> str:
    try:
        return _detect_windows_physical_host() or "0.0.0.0"
    except Exception:  # noqa: BLE001
        return "0.0.0.0"


def _default_host() -> str:
    override = os.getenv("BILIKARA_HOST", "").strip()
    if override:
        return override

    # Packaged Windows keeps its concrete LAN listener for the existing Local
    # Remote. The server adds a separate loopback-only companion listener for
    # the Host UI, without exposing virtual adapters.
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
        exe_dir = Path(sys.executable).resolve().parent
        if sys.platform == "darwin" and exe_dir.name == "MacOS" and exe_dir.parent.name == "Contents":
            resources = exe_dir.parent / "Resources"
            if resources.exists():
                return resources
        return exe_dir
    return Path(__file__).resolve().parent.parent


def _frozen_runtime_home() -> Path:
    if sys.platform == "darwin":
        return Path("~/Library/Application Support/bilikara").expanduser()
    return Path(sys.executable).resolve().parent / "runtime"


def _default_app_home() -> Path:
    override = os.getenv("BILIKARA_HOME", "").strip()
    if override:
        return Path(override).expanduser()

    if getattr(sys, "frozen", False):
        return _frozen_runtime_home()

    return _resource_root()


def _split_env_urls(name: str) -> tuple[str, ...]:
    raw = os.getenv(name, "")
    if not raw:
        return ()
    normalized = raw.replace("\n", ",").replace(";", ",")
    return tuple(part.strip() for part in normalized.split(",") if part.strip())


def _env_truthy(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


ROOT_DIR = _resource_root()
APP_HOME = _default_app_home()
PACKAGED_RUNTIME = bool(getattr(sys, "frozen", False))
STATIC_DIR = ROOT_DIR / "static"
APP_VERSION_FILE = ROOT_DIR / "APP_VERSION"
DATA_DIR = APP_HOME / "data"
CACHE_DIR = DATA_DIR / "cache"
LOG_DIR = DATA_DIR / "logs"
PLAYED_SESSION_DIR = DATA_DIR / "played_sessions"
STATE_FILE = DATA_DIR / "state.json"
REMOTE_IDENTITIES_FILE = DATA_DIR / "remote_identities.json"
BACKUP_FILE = DATA_DIR / "playlist_backup.json"
CACHE_POLICY_FILE = DATA_DIR / "cache_policy.json"
TOOLS_DIR = APP_HOME / "tools"
VENDOR_DIR = ROOT_DIR / "vendor"
INTERNAL_VENDOR_DIR = ROOT_DIR / "_internal" / "vendor"
BB_DOWN_DIR = TOOLS_DIR / "bbdown"
BB_DOWN_BUNDLED_PATH = VENDOR_DIR / ("BBDown.exe" if os.name == "nt" else "BBDown")
FFMPEG_TOOLS_DIR = BB_DOWN_DIR
FFMPEG_RUNTIME_PATH = FFMPEG_TOOLS_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
FFPROBE_RUNTIME_PATH = FFMPEG_TOOLS_DIR / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
FFMPEG_BUNDLED_PATH = VENDOR_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
FFPROBE_BUNDLED_PATH = VENDOR_DIR / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
BB_DOWN_VERSION_FILE = BB_DOWN_DIR / "VERSION"
YTDLP_DIR = TOOLS_DIR / "ytdlp"
YTDLP_PATH_OVERRIDE = os.getenv("YT_DLP_PATH", "").strip()
ARIA2C_DIR = TOOLS_DIR / "aria2c"
ARIA2C_PATH_OVERRIDE = os.getenv("ARIA2C_PATH", "").strip()
ARIA2_MACOS_METADATA_PATH = VENDOR_DIR / "aria2-macos.json"
GATCHA_UIDS = ["3145040", "671767", "33091201", "3494356589742209", "44627483", "8474818", "10077309", "74089392", "1879151", "87101327", "99061404", "602998", "1159885664", "215040", "31624333", "21129450", "2625848", "29955371", "3014315", "80148988", "464873", "41924655", "356716", "174980119", "1326466", "13775191", "524220885"]
GATCHA_KEYWORDS = ["卡拉", "カラ", "投屏","KTV","纯K","纯k","kara","Kara","karaoke","Karaoke","vocal","Vocal","伴奏"]
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
YTDLP_RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"
ARIA2_RELEASE_API = "https://api.github.com/repos/aria2/aria2/releases/latest"
TOOL_ASSET_BASE_URL = os.getenv("BILIKARA_TOOL_ASSET_BASE_URL", "https://download.kevinx96.icu/bilikara/tools").strip().rstrip("/")
APP_RELEASE_API = "https://api.github.com/repos/VZRXS/bilikara/releases/latest"
APP_RELEASES_URL = "https://github.com/VZRXS/bilikara/releases"
APP_RELEASE_API_FALLBACKS = (
    "https://api.kevinx96.icu/bilikara/releases/latest",
    *_split_env_urls("BILIKARA_APP_RELEASE_API_FALLBACKS"),
)
APP_RELEASES_API_FALLBACKS = (
    "https://api.kevinx96.icu/bilikara/releases",
    *_split_env_urls("BILIKARA_APP_RELEASES_API_FALLBACKS"),
)
APP_UPDATE_DOWNLOAD_PROXY = os.getenv("BILIKARA_UPDATE_DOWNLOAD_PROXY", "").strip()
APP_UPDATE_DOWNLOAD_PROXY_FIRST = _env_truthy("BILIKARA_UPDATE_DOWNLOAD_PROXY_FIRST")


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
