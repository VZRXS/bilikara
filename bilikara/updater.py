from __future__ import annotations

import json
import re
import urllib.request
from typing import Any, Callable

from .config import APP_RELEASE_API, APP_RELEASES_URL, APP_VERSION

VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$", re.IGNORECASE)
APP_RELEASES_API = APP_RELEASE_API.rsplit("/", 1)[0] if APP_RELEASE_API.endswith("/latest") else APP_RELEASE_API


def normalize_version_tag(version: object) -> str:
    return str(version or "").strip()


def version_tuple(version: object) -> tuple[int, int, int] | None:
    match = VERSION_RE.match(normalize_version_tag(version))
    if not match:
        return None
    return tuple(int(part) for part in match.groups()[:3])


def version_sort_key(version: object) -> tuple[int, int, int, int, int] | None:
    match = VERSION_RE.match(normalize_version_tag(version))
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.groups()[:3])
    preview_number = match.group(4)
    if preview_number is None:
        return (major, minor, patch, 1, 0)
    return (major, minor, patch, 0, int(preview_number))


def is_release_version(version: object) -> bool:
    return version_sort_key(version) is not None


def is_preview_version(version: object) -> bool:
    match = VERSION_RE.match(normalize_version_tag(version))
    return bool(match and match.group(4) is not None)


def is_stable_version(version: object) -> bool:
    return is_release_version(version) and not is_preview_version(version)


def is_newer_version(latest_version: object, current_version: object) -> bool:
    latest_key = version_sort_key(latest_version)
    current_key = version_sort_key(current_version)
    if latest_key is None or current_key is None:
        return False
    return latest_key > current_key


def fetch_releases() -> list[dict[str, Any]]:
    request = urllib.request.Request(
        APP_RELEASES_API,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "bilikara-update-check",
        },
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not isinstance(payload, list):
        raise RuntimeError("GitHub Release 响应格式不正确")
    return payload


def fetch_latest_release() -> dict[str, Any]:
    releases = fetch_releases()
    if not releases:
        raise RuntimeError("没有找到 GitHub Release")
    return releases[0]


def _coerce_releases(payload: object) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        return [payload]
    if isinstance(payload, list):
        return [release for release in payload if isinstance(release, dict)]
    return []


def _latest_release_for_current(current_version: str, releases: list[dict[str, Any]]) -> dict[str, Any]:
    valid_releases = [
        release
        for release in releases
        if not release.get("draft") and version_sort_key(release.get("tag_name")) is not None
    ]
    if not valid_releases:
        return {}

    latest_any = max(valid_releases, key=lambda release: version_sort_key(release.get("tag_name")) or (0, 0, 0, 0, 0))
    stable_releases = [
        release
        for release in valid_releases
        if is_stable_version(release.get("tag_name"))
    ]
    latest_stable = (
        max(stable_releases, key=lambda release: version_sort_key(release.get("tag_name")) or (0, 0, 0, 0, 0))
        if stable_releases
        else {}
    )

    if is_stable_version(current_version):
        return latest_stable
    if is_preview_version(current_version):
        return latest_any
    return latest_stable or latest_any


def check_for_update(
    *,
    current_version: str = APP_VERSION,
    release_fetcher: Callable[[], object] = fetch_releases,
) -> dict[str, Any]:
    releases = _coerce_releases(release_fetcher())
    release = _latest_release_for_current(normalize_version_tag(current_version) or "dev", releases)
    latest_version = normalize_version_tag(release.get("tag_name"))
    release_url = str(release.get("html_url") or APP_RELEASES_URL)
    current_version = normalize_version_tag(current_version) or "dev"
    current_is_release = is_release_version(current_version)
    latest_is_release = is_release_version(latest_version)
    update_available = is_newer_version(latest_version, current_version)
    switch_to_release_available = bool(latest_version and latest_is_release and not current_is_release)
    latest_channel = "预览版" if is_preview_version(latest_version) else "正式版"

    if switch_to_release_available:
        message = f"当前是开发版或非正式版（{current_version}），最新{latest_channel}是 {latest_version}。"
    elif update_available:
        message = f"发现新{latest_channel} {latest_version}，当前版本 {current_version}。"
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
