from __future__ import annotations

import json
import os
import platform as platform_module
import re
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PureWindowsPath
from typing import Any, Callable

from . import rust_backend, rust_runtime
from .config import (
    APP_HOME,
    APP_RELEASE_API,
    APP_RELEASE_API_FALLBACKS,
    APP_RELEASES_API_FALLBACKS,
    APP_RELEASES_URL,
    APP_UPDATE_DOWNLOAD_PROXY,
    APP_UPDATE_DOWNLOAD_PROXY_FIRST,
    APP_VERSION,
)

VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$", re.IGNORECASE)
APP_RELEASES_API = APP_RELEASE_API.rsplit("/", 1)[0] if APP_RELEASE_API.endswith("/latest") else APP_RELEASE_API
APP_UPDATE_TIMEOUT_SECONDS = 5
APP_UPDATE_DOWNLOAD_TIMEOUT_SECONDS = 30
APP_UPDATE_NETWORK_ERROR = "无法连接 GitHub Releases，请检查网络后重试"
APP_UPDATE_TIMEOUT_ERROR = "连接 GitHub Releases 超时，请稍后重试"
APP_UPDATE_UNSUPPORTED_ERROR = "当前平台暂不支持自动原地更新，请打开 GitHub Releases 手动下载"
APP_UPDATE_NO_ASSET_ERROR = "没有找到适用于当前平台的自动更新包，请打开 GitHub Releases 手动下载"
APP_UPDATE_BUSY_STATES = {"checking", "downloading", "installing", "restarting"}
APP_UPDATE_SUPPORTED_PLATFORMS = {"windows", "macos"}
APP_UPDATE_CHUNK_SIZE = 1024 * 256


class AppUpdateError(RuntimeError):
    pass


UPDATE_ACTION_NORMAL_UPGRADE = "normal_upgrade"
UPDATE_ACTION_PREVIEW_TO_STABLE = "preview_to_stable"
UPDATE_ACTION_DEVELOPMENT_TO_STABLE = "development_to_stable"
UPDATE_ACTION_DEVELOPMENT_TO_PREVIEW = "development_to_preview"
UPDATE_ACTION_NONE = "no_action"

UPDATE_INSTALLABLE_ACTIONS = {
    UPDATE_ACTION_NORMAL_UPGRADE,
    UPDATE_ACTION_PREVIEW_TO_STABLE,
    UPDATE_ACTION_DEVELOPMENT_TO_STABLE,
    UPDATE_ACTION_DEVELOPMENT_TO_PREVIEW,
}


def _py_dedupe_urls(urls: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for url in urls:
        normalized = str(url or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _update_candidate_inputs(
    urls: list[object],
    sources: list[str] | None = None,
) -> list[dict[str, object]]:
    return [
        {
            "original_index": index,
            "url": str(url or ""),
            "source": sources[index] if sources is not None else "primary",
        }
        for index, url in enumerate(urls)
    ]


def _update_download_plan_request(
    candidates: list[dict[str, object]],
    *,
    proxy: str | None = None,
    proxy_first: bool = False,
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "candidates": candidates,
        "proxy": (
            {"template": str(proxy), "proxy_first": bool(proxy_first)}
            if proxy is not None
            else None
        ),
    }


def _py_plan_update_download_candidates(
    candidates: list[dict[str, object]],
    *,
    proxy: str | None = None,
    proxy_first: bool = False,
) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    seen: set[str] = set()
    for candidate in candidates:
        direct_url = str(candidate.get("url") or "").strip()
        if not direct_url:
            continue
        proxy_url = (
            _py_format_download_proxy_url(str(proxy), direct_url)
            if proxy is not None
            else ""
        )
        if proxy_url.strip() == direct_url:
            proxy_url = ""
        ordered = (
            (("proxy", proxy_url), ("direct", direct_url))
            if proxy_first
            else (("direct", direct_url), ("proxy", proxy_url))
        )
        for route, raw_url in ordered:
            url = str(raw_url or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            result.append(
                {
                    "input_index": candidate["original_index"],
                    "source": candidate["source"],
                    "route": route,
                    "url": url,
                }
            )
    return result


def _try_native_update_download_plan(
    candidates: list[dict[str, object]],
    *,
    proxy: str | None = None,
    proxy_first: bool = False,
) -> tuple[bool, list[dict[str, object]]]:
    completed, response = rust_backend.try_plan_update_download_candidates(
        _update_download_plan_request(
            candidates,
            proxy=proxy,
            proxy_first=proxy_first,
        )
    )
    if not completed or response is None:
        return False, []
    return True, list(response["candidates"])


def _dedupe_urls(urls: list[str]) -> list[str]:
    candidates = _update_candidate_inputs(list(urls))
    completed, plan = _try_native_update_download_plan(candidates)
    if completed:
        return [str(candidate["url"]) for candidate in plan]
    return rust_backend.python_fallback(
        "plan_update_download_candidates", lambda: _py_dedupe_urls(urls)
    )


def _py_release_list_api_from_latest(api_url: str) -> str:
    url = str(api_url or "").strip()
    if url.endswith("/latest"):
        return url.rsplit("/", 1)[0]
    return ""


def _release_list_api_from_latest(api_url: str) -> str:
    api_url_text = str(api_url or "")
    rust_result = rust_backend.release_list_api_from_latest(api_url_text)
    if rust_result is not None:
        return rust_result
    return _py_release_list_api_from_latest(api_url)


def _py_latest_release_api_urls(
    primary_url: object,
    fallback_urls: tuple[str, ...] | list[str],
) -> list[str]:
    return _py_dedupe_urls([str(primary_url or ""), *fallback_urls])


def _latest_release_api_urls() -> list[str]:
    urls = [APP_RELEASE_API, *APP_RELEASE_API_FALLBACKS]
    sources = ["primary", *("mirror" for _ in APP_RELEASE_API_FALLBACKS)]
    candidates = _update_candidate_inputs(urls, sources)
    completed, plan = _try_native_update_download_plan(candidates)
    if completed:
        return [str(candidate["url"]) for candidate in plan]
    return rust_backend.python_fallback(
        "plan_update_download_candidates",
        lambda: _py_latest_release_api_urls(
            APP_RELEASE_API, APP_RELEASE_API_FALLBACKS
        ),
    )


def _py_release_list_api_urls(
    primary_url: object,
    fallback_urls: tuple[str, ...] | list[str],
    latest_fallback_urls: tuple[str, ...] | list[str],
) -> list[str]:
    derived_fallbacks = [
        _py_release_list_api_from_latest(url) for url in latest_fallback_urls
    ]
    return _py_dedupe_urls(
        [str(primary_url or ""), *fallback_urls, *derived_fallbacks]
    )


def _release_list_api_urls() -> list[str]:
    derived_fallbacks = [
        _release_list_api_from_latest(url)
        for url in APP_RELEASE_API_FALLBACKS
    ]
    urls = [APP_RELEASES_API, *APP_RELEASES_API_FALLBACKS, *derived_fallbacks]
    sources = [
        "primary",
        *("mirror" for _ in APP_RELEASES_API_FALLBACKS),
        *("derived_mirror" for _ in derived_fallbacks),
    ]
    candidates = _update_candidate_inputs(urls, sources)
    completed, plan = _try_native_update_download_plan(candidates)
    if completed:
        return [str(candidate["url"]) for candidate in plan]
    return rust_backend.python_fallback(
        "plan_update_download_candidates",
        lambda: _py_release_list_api_urls(
            APP_RELEASES_API,
            APP_RELEASES_API_FALLBACKS,
            APP_RELEASE_API_FALLBACKS,
        ),
    )


def _py_format_download_proxy_url(proxy: str, url: str) -> str:
    proxy = str(proxy or "").strip()
    url = str(url or "").strip()
    if not proxy or not url:
        return ""
    encoded_url = urllib.parse.quote(url, safe="")
    if "{url_encoded}" in proxy:
        return proxy.replace("{url_encoded}", encoded_url)
    if "{url}" in proxy:
        return proxy.replace("{url}", url)
    separator = "" if proxy.endswith(("/", "=", "?", "&")) else "/"
    return f"{proxy}{separator}{url}"


def _format_download_proxy_url(proxy: str, url: str) -> str:
    proxy_text = str(proxy or "")
    url_text = str(url or "")
    rust_result = rust_backend.format_download_proxy_url(proxy_text, url_text)
    if rust_result is not None:
        return rust_result
    return _py_format_download_proxy_url(proxy, url)


def _py_download_url_candidates(
    url: object,
    proxy: object,
    proxy_first: bool,
) -> list[str]:
    normalized_url = str(url or "").strip()
    if not normalized_url:
        return []
    proxy_url = _py_format_download_proxy_url(str(proxy or ""), normalized_url)
    if not proxy_url or proxy_url == normalized_url:
        return [normalized_url]
    candidates = (
        [proxy_url, normalized_url]
        if proxy_first
        else [normalized_url, proxy_url]
    )
    return _py_dedupe_urls(candidates)


def _download_url_candidates(url: str) -> list[str]:
    candidates = _update_candidate_inputs([url], ["primary"])
    completed, plan = _try_native_update_download_plan(
        candidates,
        proxy=APP_UPDATE_DOWNLOAD_PROXY,
        proxy_first=APP_UPDATE_DOWNLOAD_PROXY_FIRST,
    )
    if completed:
        return [str(candidate["url"]) for candidate in plan]
    return rust_backend.python_fallback(
        "plan_update_download_candidates",
        lambda: _py_download_url_candidates(
            url,
            APP_UPDATE_DOWNLOAD_PROXY,
            APP_UPDATE_DOWNLOAD_PROXY_FIRST,
        ),
    )


def _py_normalize_version_tag(version: object) -> str:
    return str(version or "").strip()


def normalize_version_tag(version: object) -> str:
    version_text = str(version or "")
    rust_result = rust_backend.normalize_version_tag(version_text)
    if rust_result is not None:
        return rust_result
    return _py_normalize_version_tag(version)


def _py_version_tuple(version: object) -> tuple[int, int, int] | None:
    match = VERSION_RE.match(_py_normalize_version_tag(version))
    if not match:
        return None
    return tuple(int(part) for part in match.groups()[:3])


def version_tuple(version: object) -> tuple[int, int, int] | None:
    completed, rust_result = rust_backend.try_version_tuple(str(version or ""))
    if completed:
        return rust_result
    return _py_version_tuple(version)


def _py_version_sort_key(version: object) -> tuple[int, int, int, int, int] | None:
    match = VERSION_RE.match(_py_normalize_version_tag(version))
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.groups()[:3])
    preview_number = match.group(4)
    if preview_number is None:
        return (major, minor, patch, 1, 0)
    return (major, minor, patch, 0, int(preview_number))


def version_sort_key(version: object) -> tuple[int, int, int, int, int] | None:
    completed, rust_result = rust_backend.try_version_sort_key(str(version or ""))
    if completed:
        return rust_result
    return _py_version_sort_key(version)


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


def _py_fetch_release_json_once(url: str) -> object:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "bilikara-update-check",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=APP_UPDATE_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except (TimeoutError, socket.timeout) as exc:
        raise RuntimeError(APP_UPDATE_TIMEOUT_ERROR) from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            raise RuntimeError(APP_UPDATE_TIMEOUT_ERROR) from exc
        raise RuntimeError(APP_UPDATE_NETWORK_ERROR) from exc


def _fetch_release_json_once(url: str) -> object:
    try:
        return rust_runtime.json_http_request(
            "GET",
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "bilikara-update-check",
            },
            timeout=APP_UPDATE_TIMEOUT_SECONDS,
        )
    except rust_runtime.RustRuntimeUnavailableError:
        return rust_backend.python_fallback(
            "fetch_release_json",
            lambda: _py_fetch_release_json_once(url),
        )
    except rust_runtime.RustRuntimeServiceError as exc:
        if exc.kind == "timeout":
            raise RuntimeError(APP_UPDATE_TIMEOUT_ERROR) from exc
        raise RuntimeError(APP_UPDATE_NETWORK_ERROR) from exc


def _fetch_release_json(urls: str | list[str] | tuple[str, ...]) -> object:
    candidates = _dedupe_urls([urls] if isinstance(urls, str) else list(urls))
    last_error: RuntimeError | None = None
    for url in candidates:
        try:
            return _fetch_release_json_once(url)
        except RuntimeError as exc:
            last_error = exc
    if last_error is not None:
        raise last_error
    raise RuntimeError(APP_UPDATE_NETWORK_ERROR)


def fetch_releases() -> list[dict[str, Any]]:
    payload = _fetch_release_json(_release_list_api_urls())
    if not isinstance(payload, list):
        raise RuntimeError("GitHub Release 响应格式不正确")
    return payload


def fetch_latest_release() -> dict[str, Any]:
    payload = _fetch_release_json(_latest_release_api_urls())
    if not isinstance(payload, dict):
        raise RuntimeError("GitHub Release 响应格式不正确")
    return payload


def _coerce_releases(payload: object) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        return [payload]
    if isinstance(payload, list):
        return [release for release in payload if isinstance(release, dict)]
    return []


def _py_is_release_version(version: object) -> bool:
    return _py_version_sort_key(version) is not None


def _py_is_preview_version(version: object) -> bool:
    match = VERSION_RE.match(_py_normalize_version_tag(version))
    return bool(match and match.group(4) is not None)


def _py_is_stable_version(version: object) -> bool:
    return _py_is_release_version(version) and not _py_is_preview_version(version)


def _py_latest_release_for_current(
    current_version: str,
    releases: list[dict[str, Any]],
    *,
    include_preview: bool = False,
) -> dict[str, Any]:
    valid_releases = [
        release
        for release in releases
        if not release.get("draft") and _py_version_sort_key(release.get("tag_name")) is not None
    ]
    if not valid_releases:
        return {}

    latest_any = max(
        valid_releases,
        key=lambda release: _py_version_sort_key(release.get("tag_name")) or (0, 0, 0, 0, 0),
    )
    stable_releases = [
        release
        for release in valid_releases
        if _py_is_stable_version(release.get("tag_name"))
    ]
    latest_stable = (
        max(
            stable_releases,
            key=lambda release: _py_version_sort_key(release.get("tag_name")) or (0, 0, 0, 0, 0),
        )
        if stable_releases
        else {}
    )

    if include_preview:
        return latest_any
    return latest_stable


def _py_release_decision_for_current(
    current_version: str,
    releases: list[dict[str, Any]],
    *,
    include_preview: bool = False,
) -> dict[str, Any]:
    selected = _py_latest_release_for_current(
        current_version, releases, include_preview=include_preview
    )
    if not selected:
        valid_releases = [
            release
            for release in releases
            if not release.get("draft") and _py_version_sort_key(release.get("tag_name")) is not None
        ]
        reason = "no_eligible_release" if (include_preview or not valid_releases) else "no_stable_release"
        return {
            "release": {},
            "action": UPDATE_ACTION_NONE,
            "reason": reason,
        }

    current_key = _py_version_sort_key(current_version)
    selected_key = _py_version_sort_key(selected.get("tag_name"))
    assert selected_key is not None
    selected_is_stable = _py_is_stable_version(selected.get("tag_name"))

    if current_key is None:
        if selected_is_stable:
            action = UPDATE_ACTION_DEVELOPMENT_TO_STABLE
            reason = "development_build"
        elif include_preview:
            action = UPDATE_ACTION_DEVELOPMENT_TO_PREVIEW
            reason = "development_build"
        else:
            action = UPDATE_ACTION_NONE
            reason = "development_target_not_stable"
    elif selected_key > current_key:
        action = UPDATE_ACTION_NORMAL_UPGRADE
        reason = "newer_version"
    elif not include_preview and _py_is_preview_version(current_version) and selected_is_stable:
        action = UPDATE_ACTION_PREVIEW_TO_STABLE
        reason = "preview_channel_disabled"
    elif selected_key == current_key:
        action = UPDATE_ACTION_NONE
        reason = "already_current"
    elif _py_is_stable_version(current_version):
        action = UPDATE_ACTION_NONE
        reason = "stable_not_newer"
    else:
        action = UPDATE_ACTION_NONE
        reason = "preview_not_newer"

    return {
        "release": selected,
        "action": action,
        "reason": reason,
    }


def _release_decision_for_current(
    current_version: str,
    releases: list[dict[str, Any]],
    *,
    include_preview: bool = False,
) -> dict[str, Any]:
    request: dict[str, object] = {
        "schema_version": 1,
        "current_version": str(current_version),
        "include_preview": bool(include_preview),
        "releases": [
            {
                "tag_name": str(r.get("tag_name") or ""),
                "draft": bool(r.get("draft")),
                "prerelease": bool(r.get("prerelease")),
            }
            for r in releases
            if isinstance(r, dict)
        ],
    }
    completed, response = rust_backend.try_select_release(request)
    if completed and response is not None:
        status = response.get("status")
        action = str(response.get("action") or UPDATE_ACTION_NONE)
        reason = str(response.get("reason") or "")
        if status == "selected":
            selected_index = response.get("selected_index")
            if (
                isinstance(selected_index, int)
                and not isinstance(selected_index, bool)
                and 0 <= selected_index < len(releases)
            ):
                selected = releases[selected_index]
                if not selected.get("draft") and is_release_version(selected.get("tag_name")):
                    if include_preview or is_stable_version(selected.get("tag_name")):
                        return {
                            "release": selected,
                            "action": action,
                            "reason": reason,
                        }
        elif status == "no_match":
            return {
                "release": {},
                "action": action,
                "reason": reason,
            }

    return rust_backend.python_fallback(
        "select_release",
        lambda: _py_release_decision_for_current(
            current_version, releases, include_preview=include_preview
        ),
    )


def _latest_release_for_current(
    current_version: str,
    releases: list[dict[str, Any]],
    *,
    include_preview: bool = False,
) -> dict[str, Any]:
    return _release_decision_for_current(
        current_version, releases, include_preview=include_preview
    )["release"]


def _py_normalize_machine_arch(machine: object) -> str:
    normalized = str(machine or "").strip().lower().replace(" ", "")
    if normalized in {"amd64", "x86_64", "x64"}:
        return "x64"
    if normalized in {"arm64", "aarch64"}:
        return "arm64"
    if normalized in {"i386", "i686", "x86"}:
        return "x86"
    return normalized or "unknown"


def normalize_machine_arch(machine: object) -> str:
    machine_text = str(machine or "")
    rust_result = rust_backend.normalize_machine_arch(machine_text)
    if rust_result is not None:
        return rust_result
    return _py_normalize_machine_arch(machine)


def detect_update_target() -> dict[str, str]:
    system = platform_module.system().lower()
    if system == "windows" or sys.platform.startswith("win"):
        platform_key = "windows"
    elif system == "darwin" or sys.platform == "darwin":
        platform_key = "macos"
    elif system == "linux" or sys.platform.startswith("linux"):
        platform_key = "linux"
    else:
        platform_key = system or sys.platform or "unknown"
    arch = normalize_machine_arch(platform_module.machine())
    return {
        "platform": platform_key,
        "arch": arch,
        "system": system or sys.platform,
        "machine": str(platform_module.machine() or ""),
    }


def _asset_text(asset: dict[str, Any]) -> str:
    return " ".join(
        str(asset.get(key) or "")
        for key in ("name", "label", "browser_download_url", "content_type")
    ).lower()


def _py_asset_tokens(text: str) -> set[str]:
    return {part for part in re.split(r"[^a-z0-9]+", text.lower()) if part}


def _py_asset_has_windows(tokens: set[str]) -> bool:
    return bool(tokens & {"windows", "window", "win", "win32", "win64"})


def _py_asset_has_macos(tokens: set[str]) -> bool:
    return bool(tokens & {"macos", "mac", "darwin", "osx", "app"})


def _py_asset_has_linux(tokens: set[str]) -> bool:
    return "linux" in tokens


def _py_asset_has_x64(text: str, tokens: set[str]) -> bool:
    return "x86_64" in text or bool(tokens & {"x64", "amd64", "win64"})


def _py_asset_has_arm64(text: str, tokens: set[str]) -> bool:
    return bool(tokens & {"arm64", "aarch64"})


def _py_asset_has_universal(tokens: set[str]) -> bool:
    return bool(tokens & {"universal", "universal2"})


def _asset_tokens(text: str) -> set[str]:
    rust_result = rust_backend.asset_tokens(text)
    if rust_result is not None:
        return rust_result
    return _py_asset_tokens(text)


def _asset_has_windows(tokens: set[str]) -> bool:
    rust_result = rust_backend.asset_has_windows(tokens)
    if rust_result is not None:
        return rust_result
    return _py_asset_has_windows(tokens)


def _asset_has_macos(tokens: set[str]) -> bool:
    rust_result = rust_backend.asset_has_macos(tokens)
    if rust_result is not None:
        return rust_result
    return _py_asset_has_macos(tokens)


def _asset_has_linux(tokens: set[str]) -> bool:
    rust_result = rust_backend.asset_has_linux(tokens)
    if rust_result is not None:
        return rust_result
    return _py_asset_has_linux(tokens)


def _asset_has_x64(text: str, tokens: set[str]) -> bool:
    rust_result = rust_backend.asset_has_x64(text, tokens)
    if rust_result is not None:
        return rust_result
    return _py_asset_has_x64(text, tokens)


def _asset_has_arm64(text: str, tokens: set[str]) -> bool:
    rust_result = rust_backend.asset_has_arm64(tokens)
    if rust_result is not None:
        return rust_result
    return _py_asset_has_arm64(text, tokens)


def _asset_has_universal(tokens: set[str]) -> bool:
    rust_result = rust_backend.asset_has_universal(tokens)
    if rust_result is not None:
        return rust_result
    return _py_asset_has_universal(tokens)


def _coerce_asset_size(asset: dict[str, Any]) -> int:
    try:
        return max(0, int(asset.get("size") or 0))
    except (TypeError, ValueError):
        return 0


def _py_is_downloadable_archive(asset: dict[str, Any]) -> bool:
    name = str(asset.get("name") or "").strip().lower()
    url = str(asset.get("browser_download_url") or "").strip().lower()
    if not url:
        return False
    if name.endswith((".sha256", ".sha256sum", ".sig", ".asc", ".txt")):
        return False
    return name.endswith(".zip") or url.split("?", 1)[0].endswith(".zip")


def _is_downloadable_archive(asset: dict[str, Any]) -> bool:
    name = str(asset.get("name") or "")
    url = str(asset.get("browser_download_url") or "")
    rust_result = rust_backend.is_downloadable_archive(name, url)
    if rust_result is not None:
        return rust_result
    return _py_is_downloadable_archive(asset)


def _py_score_asset_for_target(asset: dict[str, Any], target: dict[str, str]) -> int:
    if not _py_is_downloadable_archive(asset):
        return -1

    text = _asset_text(asset)
    tokens = _py_asset_tokens(text)
    target_platform = str(target.get("platform") or "")
    target_arch = str(target.get("arch") or "")

    windows_asset = _py_asset_has_windows(tokens)
    macos_asset = _py_asset_has_macos(tokens)
    linux_asset = _py_asset_has_linux(tokens)
    x64_asset = _py_asset_has_x64(text, tokens)
    arm64_asset = _py_asset_has_arm64(text, tokens)
    universal_asset = _py_asset_has_universal(tokens)

    if target_platform == "windows":
        if macos_asset or linux_asset or not windows_asset:
            return -1
        platform_score = 100
    elif target_platform == "macos":
        if windows_asset or linux_asset:
            return -1
        platform_score = 100 if macos_asset else 0
        if platform_score <= 0:
            return -1
    else:
        return -1

    if target_arch == "arm64":
        if arm64_asset:
            arch_score = 40
        elif target_platform == "macos" and universal_asset:
            arch_score = 30
        elif x64_asset or target_platform == "windows":
            return -1
        else:
            arch_score = 5
    elif target_arch in {"x64", "amd64"}:
        if x64_asset:
            arch_score = 40
        elif target_platform == "macos" and universal_asset:
            arch_score = 30
        elif arm64_asset:
            return -1
        else:
            arch_score = 5
    else:
        if x64_asset or arm64_asset or universal_asset:
            arch_score = 5
        else:
            arch_score = 0

    return platform_score + arch_score


def _score_asset_for_target(asset: dict[str, Any], target: dict[str, str]) -> int:
    # Reuse the coarse selection ABI with a single descriptor instead of
    # exporting a second, tiny scoring symbol.
    request: dict[str, object] = {
        "schema_version": 1,
        "target": {
            "platform": str(target.get("platform") or ""),
            "arch": str(target.get("arch") or ""),
        },
        "assets": [
            {
                "original_index": 0,
                "name": str(asset.get("name") or ""),
                "label": str(asset.get("label") or ""),
                "browser_download_url": str(
                    asset.get("browser_download_url") or ""
                ),
                "content_type": str(asset.get("content_type") or ""),
            }
        ],
    }
    completed, response = rust_backend.try_select_update_asset(request)
    if completed and response is not None:
        scores = response.get("scores")
        if isinstance(scores, list) and len(scores) == 1:
            score_entry = scores[0]
            if isinstance(score_entry, dict):
                score = score_entry.get("score")
                if isinstance(score, int) and not isinstance(score, bool):
                    return score
    return rust_backend.python_fallback(
        "select_update_asset", lambda: _py_score_asset_for_target(asset, target)
    )


def _py_select_update_asset(
    release: dict[str, Any] | None,
    *,
    target: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    if not isinstance(release, dict):
        return None
    target = target or detect_update_target()
    assets = release.get("assets")
    if not isinstance(assets, list):
        return None

    scored_assets: list[tuple[int, int, dict[str, Any]]] = []
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            continue
        score = _py_score_asset_for_target(asset, target)
        if score < 0:
            continue
        scored_assets.append((score, -index, asset))
    if not scored_assets:
        return None

    _, _, selected = max(scored_assets, key=lambda item: item[:2])
    return {
        "name": str(selected.get("name") or ""),
        "browser_download_url": str(selected.get("browser_download_url") or ""),
        "size": _coerce_asset_size(selected),
        "content_type": str(selected.get("content_type") or ""),
        "platform": str(target.get("platform") or ""),
        "arch": str(target.get("arch") or ""),
    }


def select_update_asset(
    release: dict[str, Any] | None,
    *,
    target: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    if not isinstance(release, dict):
        return None
    resolved_target = target or detect_update_target()
    assets = release.get("assets")
    if not isinstance(assets, list):
        return None

    request_assets: list[dict[str, object]] = []
    assets_by_index: dict[int, dict[str, Any]] = {}
    for original_index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            continue
        request_assets.append(
            {
                "original_index": original_index,
                "name": str(asset.get("name") or ""),
                "label": str(asset.get("label") or ""),
                "browser_download_url": str(
                    asset.get("browser_download_url") or ""
                ),
                "content_type": str(asset.get("content_type") or ""),
            }
        )
        assets_by_index[original_index] = asset

    request: dict[str, object] = {
        "schema_version": 1,
        "target": {
            "platform": str(resolved_target.get("platform") or ""),
            "arch": str(resolved_target.get("arch") or ""),
        },
        "assets": request_assets,
    }
    completed, response = rust_backend.try_select_update_asset(request)
    if not completed or response is None:
        return rust_backend.python_fallback(
            "select_update_asset",
            lambda: _py_select_update_asset(release, target=resolved_target),
        )
    status = response.get("status")
    if status == "no_match":
        return None
    if status != "selected":
        return rust_backend.python_fallback(
            "select_update_asset",
            lambda: _py_select_update_asset(release, target=resolved_target),
        )

    selected_index = response.get("selected_index")
    if not isinstance(selected_index, int) or isinstance(selected_index, bool):
        return rust_backend.python_fallback(
            "select_update_asset",
            lambda: _py_select_update_asset(release, target=resolved_target),
        )
    selected = assets_by_index.get(selected_index)
    if selected is None:
        return rust_backend.python_fallback(
            "select_update_asset",
            lambda: _py_select_update_asset(release, target=resolved_target),
        )
    return {
        "name": str(selected.get("name") or ""),
        "browser_download_url": str(selected.get("browser_download_url") or ""),
        "size": _coerce_asset_size(selected),
        "content_type": str(selected.get("content_type") or ""),
        "platform": str(resolved_target.get("platform") or ""),
        "arch": str(resolved_target.get("arch") or ""),
    }


def is_auto_update_supported(
    *,
    target: dict[str, str] | None = None,
    frozen: bool | None = None,
) -> bool:
    target = target or detect_update_target()
    if str(target.get("platform") or "") not in APP_UPDATE_SUPPORTED_PLATFORMS:
        return False
    if frozen is None:
        frozen = bool(getattr(sys, "frozen", False))
    if frozen:
        return True
    return os.getenv("BILIKARA_ALLOW_SOURCE_UPDATE", "").strip().lower() in {"1", "true", "yes", "on"}


def check_for_update(
    *,
    current_version: str = APP_VERSION,
    include_preview: bool = False,
    release_fetcher: Callable[[], object] | None = None,
) -> dict[str, Any]:
    if release_fetcher is None:
        release_fetcher = fetch_releases if include_preview else fetch_latest_release
    releases = _coerce_releases(release_fetcher())
    decision = _release_decision_for_current(
        current_version,
        releases,
        include_preview=include_preview,
    )
    release = decision["release"]
    update_action = str(decision["action"])
    update_reason = str(decision["reason"])
    latest_version = normalize_version_tag(release.get("tag_name"))
    release_url = str(release.get("html_url") or APP_RELEASES_URL)
    current_version = normalize_version_tag(current_version) or current_version
    current_is_release = is_release_version(current_version)
    latest_is_release = is_release_version(latest_version)
    update_available = update_action == UPDATE_ACTION_NORMAL_UPGRADE
    switch_to_release_available = update_action in {
        UPDATE_ACTION_PREVIEW_TO_STABLE,
        UPDATE_ACTION_DEVELOPMENT_TO_STABLE,
        UPDATE_ACTION_DEVELOPMENT_TO_PREVIEW,
    }
    update_installable = update_action in UPDATE_INSTALLABLE_ACTIONS
    latest_channel = "预览版" if is_preview_version(latest_version) else "正式版"
    target = detect_update_target()
    selected_asset = select_update_asset(release, target=target)
    platform_auto_update_supported = is_auto_update_supported(target=target)
    auto_update_supported = bool(
        update_installable and selected_asset and platform_auto_update_supported
    )

    if update_action == UPDATE_ACTION_PREVIEW_TO_STABLE:
        message = (
            f"当前使用预览版 {current_version}，已关闭预览版更新；"
            f"可切换到最新正式版 {latest_version}。"
        )
    elif update_action in {UPDATE_ACTION_DEVELOPMENT_TO_STABLE, UPDATE_ACTION_DEVELOPMENT_TO_PREVIEW}:
        message = f"当前是开发版或非正式版（{current_version}），最新{latest_channel}是 {latest_version}。"
    elif update_action == UPDATE_ACTION_NORMAL_UPGRADE:
        message = f"发现新{latest_channel} {latest_version}，当前版本 {current_version}。"
    elif update_reason == "no_stable_release":
        message = "没有找到可用的正式版。"
    elif update_reason == "no_eligible_release":
        message = "没有找到可用的 Release。"
    elif update_reason == "preview_not_newer":
        message = f"当前预览版已是所选更新频道的最新版本（{current_version}）。"
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
        "update_action": update_action,
        "update_reason": update_reason,
        "update_installable": update_installable,
        "update_available": update_available,
        "switch_to_release_available": switch_to_release_available,
        "include_preview": include_preview,
        "message": message,
        "platform": target,
        "update_asset": selected_asset,
        "auto_update_supported": auto_update_supported,
        "platform_auto_update_supported": platform_auto_update_supported,
    }


def _is_update_decision_installable(
    update: dict[str, Any],
    *,
    current_version: str,
    include_preview: bool,
) -> bool:
    current = _py_normalize_version_tag(current_version) or current_version
    latest = _py_normalize_version_tag(update.get("latest_version"))
    current_key = _py_version_sort_key(current)
    latest_key = _py_version_sort_key(latest)
    current_is_preview = _py_is_preview_version(current)
    latest_is_stable = _py_is_stable_version(latest)
    action = str(update.get("update_action") or "")
    reason = str(update.get("update_reason") or "")

    if action:
        if action == UPDATE_ACTION_NORMAL_UPGRADE:
            return bool(
                reason == "newer_version"
                and current_key is not None
                and latest_key is not None
                and latest_key > current_key
            )
        if action == UPDATE_ACTION_PREVIEW_TO_STABLE:
            return bool(
                reason == "preview_channel_disabled"
                and not include_preview
                and current_is_preview
                and latest_is_stable
            )
        if action == UPDATE_ACTION_DEVELOPMENT_TO_STABLE:
            return bool(
                reason == "development_build"
                and current_key is None
                and latest_is_stable
            )
        if action == UPDATE_ACTION_DEVELOPMENT_TO_PREVIEW:
            latest_is_preview = _py_is_preview_version(latest)
            return bool(
                reason == "development_build"
                and current_key is None
                and include_preview
                and latest_is_preview
            )
        return False

    if update.get("update_available"):
        return bool(
            current_key is not None
            and latest_key is not None
            and latest_key > current_key
        )
    if update.get("switch_to_release_available"):
        return bool(
            (current_key is None or current_is_preview) and latest_is_stable
        )
    return False


def _py_safe_filename(name: object, fallback: str = "bilikara-update.zip") -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(name or "")).strip(".-")
    return normalized or fallback


def _safe_filename(name: object, fallback: str = "bilikara-update.zip") -> str:
    if not isinstance(fallback, str):
        return _py_safe_filename(name, fallback=fallback)
    name_text = str(name or "")
    rust_result = rust_backend.safe_filename(name_text, fallback)
    if rust_result is not None:
        return rust_result
    return _py_safe_filename(name, fallback=fallback)


def _safe_version_dir(version: object) -> str:
    return _safe_filename(version, fallback="latest").removesuffix(".zip")


def _py_download_url_to_path(
    url: str,
    destination: Path,
    *,
    expected_size: int = 0,
    on_progress: Callable[[int, int], None] | None = None,
) -> tuple[int, int]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": "bilikara-auto-update",
        },
    )
    tmp_destination = destination.with_name(f"{destination.name}.part")
    downloaded = 0
    total = max(0, int(expected_size or 0))
    try:
        with urllib.request.urlopen(request, timeout=APP_UPDATE_DOWNLOAD_TIMEOUT_SECONDS) as response:
            try:
                total = max(total, int(response.headers.get("Content-Length") or 0))
            except (TypeError, ValueError):
                pass
            with tmp_destination.open("wb") as handle:
                while True:
                    chunk = response.read(APP_UPDATE_CHUNK_SIZE)
                    if not chunk:
                        break
                    handle.write(chunk)
                    downloaded += len(chunk)
                    if on_progress:
                        on_progress(downloaded, total)
    except (TimeoutError, socket.timeout) as exc:
        raise RuntimeError(APP_UPDATE_TIMEOUT_ERROR) from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            raise RuntimeError(APP_UPDATE_TIMEOUT_ERROR) from exc
        raise RuntimeError(APP_UPDATE_NETWORK_ERROR) from exc

    tmp_destination.replace(destination)
    return downloaded, total


def _download_url_to_path(
    url: str,
    destination: Path,
    *,
    expected_size: int = 0,
    on_progress: Callable[[int, int], None] | None = None,
) -> tuple[int, int]:
    try:
        result = rust_runtime.download_to_path(
            urls=[url],
            destination=destination,
            headers=[
                ("Accept", "application/octet-stream"),
                ("User-Agent", "bilikara-auto-update"),
            ],
            on_progress=on_progress,
            connect_timeout_ms=APP_UPDATE_DOWNLOAD_TIMEOUT_SECONDS * 1000,
            request_timeout_ms=APP_UPDATE_DOWNLOAD_TIMEOUT_SECONDS * 1000,
        )
    except rust_runtime.RustRuntimeUnavailableError:
        return rust_backend.python_fallback(
            "download_update_asset",
            lambda: _py_download_url_to_path(
                url,
                destination,
                expected_size=expected_size,
                on_progress=on_progress,
            ),
        )
    except rust_runtime.RustDownloadError as exc:
        if exc.kind in {"timeout", "connect_timeout"}:
            raise RuntimeError(APP_UPDATE_TIMEOUT_ERROR) from exc
        raise RuntimeError(APP_UPDATE_NETWORK_ERROR) from exc
    downloaded = int(result.get("bytes_written") or 0)
    total = max(downloaded, int(expected_size or 0))
    return downloaded, total


def _safe_extract_zip(zip_path: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    destination_root = destination.resolve()
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            member_path = (destination / member.filename).resolve()
            if member_path != destination_root and not str(member_path).startswith(str(destination_root) + os.sep):
                raise AppUpdateError("更新包路径不安全，已停止安装")
        archive.extractall(destination)
    return destination


def _current_macos_app_path(executable_path: Path | None = None) -> Path | None:
    path = (executable_path or Path(sys.executable)).resolve()
    for parent in path.parents:
        if parent.suffix == ".app":
            return parent
    return None


def _current_install_root(*, target: dict[str, str], executable_path: Path | None = None) -> Path:
    executable_path = (executable_path or Path(sys.executable)).resolve()
    if target.get("platform") == "macos":
        app_path = _current_macos_app_path(executable_path)
        if app_path is not None:
            return app_path
    return executable_path.parent


def _find_windows_payload_root(extract_dir: Path, executable_name: str) -> Path:
    direct = extract_dir / executable_name
    if direct.exists():
        return extract_dir
    matches = sorted(extract_dir.rglob(executable_name), key=lambda item: len(item.parts))
    if matches:
        return matches[0].parent
    exe_matches = sorted(extract_dir.rglob("*.exe"), key=lambda item: len(item.parts))
    if exe_matches:
        return exe_matches[0].parent
    raise AppUpdateError("更新包里没有找到 Windows 可执行文件")


def _find_macos_payload_app(extract_dir: Path, current_app_name: str) -> Path:
    preferred = sorted(extract_dir.rglob(current_app_name), key=lambda item: len(item.parts)) if current_app_name else []
    for item in preferred:
        if item.suffix == ".app" and item.is_dir():
            return item
    apps = sorted(extract_dir.rglob("*.app"), key=lambda item: len(item.parts))
    if apps:
        return apps[0]
    raise AppUpdateError("更新包里没有找到 macOS App")


def _coerce_positive_pid(value: object) -> int | None:
    try:
        pid = int(str(value or "").strip())
    except (TypeError, ValueError):
        return None
    return pid if pid > 0 else None


def _restart_launch_executable_name(executable_path: Path) -> str:
    if os.getenv("BILIKARA_LAUNCH_MODE", "").strip().lower() == "tauri":
        desktop_executable = os.getenv("BILIKARA_DESKTOP_EXECUTABLE", "").strip()
        if desktop_executable:
            if "\\" in desktop_executable or re.match(r"^[A-Za-z]:", desktop_executable):
                return PureWindowsPath(desktop_executable).name
            return Path(desktop_executable).name
    return executable_path.name or "bilikara.exe"


def _restart_wait_pids(primary_pid: int) -> list[int]:
    pids: list[int] = []
    for pid in (primary_pid, _coerce_positive_pid(os.getenv("BILIKARA_DESKTOP_PID", ""))):
        if pid and pid not in pids:
            pids.append(pid)
    return pids


def _write_windows_restart_script(
    script_path: Path,
    *,
    source_root: Path,
    destination_root: Path,
    executable_name: str,
    launch_executable_name: str | None = None,
    wait_pids: list[int] | None = None,
    pid: int | None = None,
) -> list[str]:
    pids = list(wait_pids or ([] if pid is None else [pid]))
    if not pids:
        pids = [os.getpid()]
    pid_list = " ".join(str(item) for item in pids)
    launch_name = launch_executable_name or executable_name
    script = f"""@echo off
setlocal
set "PIDS={pid_list}"
set "SRC={source_root}"
set "DST={destination_root}"
set "EXE={launch_name}"
set "LOG=%TEMP%\\bilikara-update.log"
for %%I in (%PIDS%) do call :waitpid %%I
robocopy "%SRC%" "%DST%" /MIR /XD runtime data updates __pycache__ /XF "%~nx0" > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 exit /b %RC%
start "" "%DST%\\%EXE%"
exit /b 0

:waitpid
set "WAITPID=%~1"
:wait
for /f "tokens=2" %%P in ('tasklist /FI "PID eq %WAITPID%" /NH 2^>nul') do (
  if "%%P"=="%WAITPID%" (
    timeout /t 1 /nobreak >nul
    goto wait
  )
)
exit /b 0
"""
    with script_path.open("w", encoding="utf-8", newline="\r\n") as handle:
        handle.write(script)
    return ["cmd", "/c", str(script_path)]

def _write_macos_restart_script(
    script_path: Path,
    *,
    source_app: Path,
    destination_app: Path,
    pid: int,
) -> list[str]:
    script = f"""#!/bin/sh
set -u
PID={pid}
SRC={shlex.quote(str(source_app))}
DST={shlex.quote(str(destination_app))}
BACKUP="${{DST}}.previous-update"
while kill -0 "$PID" 2>/dev/null; do
  sleep 1
done
rm -rf "$BACKUP"
if [ -d "$DST" ]; then
  mv "$DST" "$BACKUP" || exit 1
fi
ditto "$SRC" "$DST"
STATUS=$?
if [ "$STATUS" -eq 0 ]; then
  rm -rf "$BACKUP"
  open "$DST"
  exit 0
fi
rm -rf "$DST"
if [ -d "$BACKUP" ]; then
  mv "$BACKUP" "$DST"
  open "$DST"
fi
exit "$STATUS"
"""
    script_path.write_text(script, encoding="utf-8")
    script_path.chmod(script_path.stat().st_mode | stat.S_IXUSR)
    return ["/bin/sh", str(script_path)]


def _launch_restart_helper(command: list[str]) -> None:
    rust_runtime.launch_update_helper(command)


class AppUpdateManager:
    def __init__(
        self,
        *,
        app_home: Path = APP_HOME,
        current_version: str = APP_VERSION,
        on_status_change: Callable[[], None] | None = None,
        on_restart_requested: Callable[[], None] | None = None,
        release_checker: Callable[..., dict[str, Any]] = check_for_update,
        downloader: Callable[..., tuple[int, int]] = _download_url_to_path,
        restart_helper_launcher: Callable[[list[str]], None] = _launch_restart_helper,
        target: dict[str, str] | None = None,
        executable_path: Path | None = None,
        frozen: bool | None = None,
    ) -> None:
        self.app_home = Path(app_home)
        self.current_version = current_version
        self.on_status_change = on_status_change
        self.on_restart_requested = on_restart_requested
        self.release_checker = release_checker
        self.downloader = downloader
        self.restart_helper_launcher = restart_helper_launcher
        self.target = target or detect_update_target()
        self.executable_path = executable_path or Path(sys.executable)
        self.frozen = frozen
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._last_progress_notify = 0.0
        self._status: dict[str, Any] = {
            "state": "idle",
            "busy": False,
            "message": "",
            "error": "",
            "current_version": self.current_version,
            "latest_version": "",
            "release_url": APP_RELEASES_URL,
            "asset_name": "",
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "progress": 0.0,
            "include_preview": False,
            "update_action": UPDATE_ACTION_NONE,
            "update_reason": "",
            "platform": dict(self.target),
            "supported": is_auto_update_supported(target=self.target, frozen=self.frozen),
            "updated_at": time.time(),
        }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._status)

    def start(self, *, include_preview: bool = False, restart: bool = True) -> dict[str, Any]:
        with self._lock:
            if str(self._status.get("state") or "") in APP_UPDATE_BUSY_STATES:
                return dict(self._status)
            self._set_status_locked(
                "checking",
                busy=True,
                message="正在检查更新...",
                error="",
                include_preview=bool(include_preview),
                downloaded_bytes=0,
                total_bytes=0,
                progress=0.0,
            )
            self._thread = threading.Thread(
                target=self._run,
                kwargs={"include_preview": bool(include_preview), "restart": bool(restart)},
                daemon=True,
                name="bilikara-app-update",
            )
            self._thread.start()
            snapshot = dict(self._status)
        self._notify_status_change()
        return snapshot

    def _run(self, *, include_preview: bool, restart: bool) -> None:
        try:
            update = self.release_checker(
                current_version=self.current_version,
                include_preview=include_preview,
            )
            latest_version = normalize_version_tag(update.get("latest_version"))
            release_url = str(update.get("release_url") or APP_RELEASES_URL)
            update_action = str(update.get("update_action") or "")
            update_reason = str(update.get("update_reason") or "")
            update_needed = _is_update_decision_installable(
                update,
                current_version=self.current_version,
                include_preview=include_preview,
            )
            if not update_needed:
                self._set_status(
                    "idle",
                    busy=False,
                    message=str(update.get("message") or "当前已是最新版本。"),
                    latest_version=latest_version,
                    release_url=release_url,
                    include_preview=include_preview,
                    update_action=update_action or UPDATE_ACTION_NONE,
                    update_reason=update_reason,
                )
                return

            if not is_auto_update_supported(target=self.target, frozen=self.frozen):
                self._set_status(
                    "unsupported",
                    busy=False,
                    message=APP_UPDATE_UNSUPPORTED_ERROR,
                    error=APP_UPDATE_UNSUPPORTED_ERROR,
                    latest_version=latest_version,
                    release_url=release_url,
                    include_preview=include_preview,
                    update_action=update_action,
                    update_reason=update_reason,
                )
                return

            asset = update.get("update_asset") if isinstance(update.get("update_asset"), dict) else None
            if not asset:
                self._set_status(
                    "unsupported",
                    busy=False,
                    message=APP_UPDATE_NO_ASSET_ERROR,
                    error=APP_UPDATE_NO_ASSET_ERROR,
                    latest_version=latest_version,
                    release_url=release_url,
                    include_preview=include_preview,
                    update_action=update_action,
                    update_reason=update_reason,
                )
                return

            asset_url = str(asset.get("browser_download_url") or "")
            if not asset_url:
                raise AppUpdateError(APP_UPDATE_NO_ASSET_ERROR)
            asset_name = _safe_filename(asset.get("name") or "bilikara-update.zip")
            expected_size = _coerce_asset_size(asset)
            update_dir = self.app_home / "updates" / _safe_version_dir(latest_version or "latest")
            update_dir.mkdir(parents=True, exist_ok=True)
            archive_path = update_dir / asset_name
            extract_dir = update_dir / "extracted"

            self._set_status(
                "downloading",
                busy=True,
                message=f"正在下载更新包 {asset_name}",
                latest_version=latest_version,
                release_url=release_url,
                asset_name=asset_name,
                downloaded_bytes=0,
                total_bytes=expected_size,
                progress=0.0,
                include_preview=include_preview,
                update_action=update_action,
                update_reason=update_reason,
            )
            downloaded, total = self._download_update_archive(
                asset_url,
                archive_path,
                expected_size=expected_size,
                on_progress=self._download_progress,
            )
            self._set_status(
                "installing",
                busy=True,
                message="更新包已下载，正在准备安装...",
                downloaded_bytes=downloaded,
                total_bytes=total or expected_size,
                progress=1.0 if (total or expected_size or downloaded) else 0.0,
            )
            command = self._prepare_restart_helper(
                update_dir=update_dir,
                extract_dir=extract_dir,
                archive_path=archive_path,
            )
            self._set_status(
                "restarting" if restart else "idle",
                busy=bool(restart),
                message="更新已准备完成，正在重启服务..." if restart else "更新包已准备完成。",
                progress=1.0,
            )
            if restart:
                self.restart_helper_launcher(command)
                if self.on_restart_requested:
                    self.on_restart_requested()
        except Exception as exc:  # noqa: BLE001
            message = str(exc) or "自动更新失败"
            self._set_status(
                "failed",
                busy=False,
                message=message,
                error=message,
            )

    def _download_update_archive(
        self,
        asset_url: str,
        archive_path: Path,
        *,
        expected_size: int = 0,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> tuple[int, int]:
        last_error: Exception | None = None
        for candidate_url in _download_url_candidates(asset_url):
            try:
                return self.downloader(
                    candidate_url,
                    archive_path,
                    expected_size=expected_size,
                    on_progress=on_progress,
                )
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                archive_path.unlink(missing_ok=True)
        if last_error is not None:
            raise last_error
        raise AppUpdateError(APP_UPDATE_NO_ASSET_ERROR)

    def _download_progress(self, downloaded: int, total: int) -> None:
        now = time.monotonic()
        if now - self._last_progress_notify < 0.2 and downloaded < total:
            with self._lock:
                self._status.update(
                    downloaded_bytes=max(0, int(downloaded or 0)),
                    total_bytes=max(0, int(total or 0)),
                    progress=(max(0, int(downloaded or 0)) / max(1, int(total or 0))) if total else 0.0,
                    updated_at=time.time(),
                )
            return
        self._last_progress_notify = now
        self._set_status(
            "downloading",
            busy=True,
            downloaded_bytes=max(0, int(downloaded or 0)),
            total_bytes=max(0, int(total or 0)),
            progress=(max(0, int(downloaded or 0)) / max(1, int(total or 0))) if total else 0.0,
        )

    def _prepare_restart_helper(
        self,
        *,
        update_dir: Path,
        extract_dir: Path,
        archive_path: Path,
    ) -> list[str]:
        pid = os.getpid()
        target_platform = str(self.target.get("platform") or "")
        install_root = _current_install_root(target=self.target, executable_path=self.executable_path)
        script_suffix = ".cmd" if target_platform == "windows" else ".sh"
        script_path = update_dir / f"apply-bilikara-update{script_suffix}"
        if target_platform not in APP_UPDATE_SUPPORTED_PLATFORMS:
            raise AppUpdateError(APP_UPDATE_UNSUPPORTED_ERROR)
        return rust_runtime.prepare_update_install(
            {
                "platform": target_platform,
                "archive_path": str(archive_path),
                "extract_dir": str(extract_dir),
                "script_path": str(script_path),
                "install_root": str(install_root),
                "executable_name": self.executable_path.name or "bilikara.exe",
                "launch_executable_name": _restart_launch_executable_name(
                    self.executable_path
                ),
                "wait_pids": _restart_wait_pids(pid),
            }
        )

    def _set_status(self, state: str, **fields: Any) -> None:
        with self._lock:
            self._set_status_locked(state, **fields)
        self._notify_status_change()

    def _set_status_locked(self, state: str, **fields: Any) -> None:
        self._status.update(fields)
        self._status["state"] = state
        self._status["busy"] = bool(fields.get("busy", state in APP_UPDATE_BUSY_STATES))
        self._status["platform"] = dict(self.target)
        self._status["supported"] = is_auto_update_supported(target=self.target, frozen=self.frozen)
        self._status["updated_at"] = time.time()

    def _notify_status_change(self) -> None:
        if self.on_status_change:
            self.on_status_change()
