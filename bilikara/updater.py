from __future__ import annotations

import json
import re
import urllib.request
from typing import Any, Callable

from .config import APP_RELEASE_API, APP_RELEASES_URL, APP_VERSION

VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$", re.IGNORECASE)


def normalize_version_tag(version: object) -> str:
    return str(version or "").strip()


def version_tuple(version: object) -> tuple[int, int, int] | None:
    match = VERSION_RE.match(normalize_version_tag(version))
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def is_release_version(version: object) -> bool:
    return version_tuple(version) is not None


def is_newer_version(latest_version: object, current_version: object) -> bool:
    latest_tuple = version_tuple(latest_version)
    current_tuple = version_tuple(current_version)
    if latest_tuple is None or current_tuple is None:
        return False
    return latest_tuple > current_tuple


def fetch_latest_release() -> dict[str, Any]:
    request = urllib.request.Request(
        APP_RELEASE_API,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "bilikara-update-check",
        },
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("GitHub Release 响应格式不正确")
    return payload


def check_for_update(
    *,
    current_version: str = APP_VERSION,
    release_fetcher: Callable[[], dict[str, Any]] = fetch_latest_release,
) -> dict[str, Any]:
    release = release_fetcher()
    latest_version = normalize_version_tag(release.get("tag_name"))
    release_url = str(release.get("html_url") or APP_RELEASES_URL)
    current_version = normalize_version_tag(current_version) or "dev"
    current_is_release = is_release_version(current_version)
    latest_is_release = is_release_version(latest_version)
    update_available = is_newer_version(latest_version, current_version)
    switch_to_release_available = bool(latest_version and latest_is_release and not current_is_release)

    if switch_to_release_available:
        message = f"当前是开发版或非正式版（{current_version}），最新正式版是 {latest_version}。"
    elif update_available:
        message = f"发现新版本 {latest_version}，当前版本 {current_version}。"
    else:
        message = f"当前已是最新版本（{current_version}）。"

    return {
        "current_version": current_version,
        "latest_version": latest_version,
        "current_is_release": current_is_release,
        "latest_is_release": latest_is_release,
        "release_url": release_url,
        "release_name": str(release.get("name") or latest_version),
        "published_at": str(release.get("published_at") or ""),
        "update_available": update_available,
        "switch_to_release_available": switch_to_release_available,
        "message": message,
    }
