from __future__ import annotations

import getpass
import io
import json
import os
import platform
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .config import (
    APP_HOME,
    APP_RELEASE_API,
    APP_RELEASE_API_FALLBACKS,
    APP_VERSION,
    BILIBILI_HEADERS,
    CACHE_POLICY_FILE,
    DATA_DIR,
    LOG_DIR,
)

DIAGNOSTIC_CONFIG_FILES = (
    CACHE_POLICY_FILE,
    DATA_DIR / "gatcha_pool_config.json",
    DATA_DIR / "gatcha_uids.json",
    DATA_DIR / "gatcha_rebuild_progress.json",
)
MAX_LOG_FILES = 8
MAX_LOG_BYTES_PER_FILE = 64 * 1024
MAX_MARKDOWN_LOG_LINES = 80
REDACTED = "[REDACTED]"

SENSITIVE_KEY_RE = re.compile(
    r"(?:cookie|token|secret|password|passwd|authorization|session|sessdata|bili_jct|access[_-]?key|private[_-]?key)",
    re.IGNORECASE,
)
USERNAME_KEY_RE = re.compile(
    r"^(?:user(?:name|_name|_id)?|requester(?:_name)?|session_user(?:_name|_id)?|session_users|local_username)$",
    re.IGNORECASE,
)
TEXT_SECRET_PATTERNS = (
    re.compile(r"(?im)(cookie\s*:\s*)[^\r\n]*"),
    re.compile(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+"),
    re.compile(r"(?i)((?:cookie|sessdata|bili_jct|token|secret|password|access[_-]?key)\s*[:=]\s*)[^\s,;]+"),
    re.compile(r"(?i)([?&](?:token|secret|password|access_key|key)=)[^&#\s]+"),
)


@dataclass(frozen=True)
class DiagnosticArtifact:
    markdown: str
    files: dict[str, bytes]

    def zip_bytes(self) -> bytes:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("diagnostics.md", self.markdown.encode("utf-8"))
            for name, payload in self.files.items():
                archive.writestr(name, payload)
        return output.getvalue()


def build_diagnostic_artifact(
    *,
    cache_manager: Any,
    cache_policy: dict[str, Any],
    runtime_state: dict[str, Any],
    browser_info: dict[str, Any] | None = None,
    local_usernames: list[str] | None = None,
    connectivity_probe: Callable[[], dict[str, Any]] | None = None,
) -> DiagnosticArtifact:
    generated_at = datetime.now(timezone.utc).isoformat()
    redaction_names = list(local_usernames or [])
    system = _system_snapshot(browser_info or {}, generated_at, redaction_names)
    tools_and_tasks = cache_manager.diagnostic_snapshot()
    disk = _disk_snapshot(APP_HOME, redaction_names)
    connectivity = (connectivity_probe or probe_connectivity)()
    sanitized_policy = redact_value(cache_policy, local_usernames=redaction_names)
    sanitized_runtime = redact_value(runtime_state, local_usernames=redaction_names)
    sanitized_tools = redact_value(tools_and_tasks, local_usernames=redaction_names)
    configs = _collect_configs(redaction_names)
    logs = _collect_logs(redaction_names)

    files: dict[str, bytes] = {
        "system.json": _json_bytes(system),
        "tools-and-tasks.json": _json_bytes(sanitized_tools),
        "download-policy.json": _json_bytes(sanitized_policy),
        "runtime-state.json": _json_bytes(sanitized_runtime),
        "disk.json": _json_bytes(disk),
        "connectivity.json": _json_bytes(connectivity),
    }
    for name, payload in configs.items():
        files[f"config/{name}"] = _json_bytes(payload)
    for name, text in logs.items():
        files[f"logs/{name}"] = text.encode("utf-8", errors="replace")

    markdown = _build_markdown(
        system=system,
        tools=sanitized_tools.get("tools", {}),
        tasks=sanitized_tools.get("tasks", {}),
        policy=sanitized_policy,
        runtime=sanitized_runtime,
        disk=disk,
        connectivity=connectivity,
        logs=logs,
    )
    return DiagnosticArtifact(markdown=markdown, files=files)


def probe_connectivity(timeout: float = 5.0) -> dict[str, Any]:
    targets = {
        "bilibili": "https://api.bilibili.com/x/web-interface/nav",
        "github": APP_RELEASE_API,
        "r2_mirror": APP_RELEASE_API_FALLBACKS[0] if APP_RELEASE_API_FALLBACKS else "",
    }
    with ThreadPoolExecutor(max_workers=len(targets)) as executor:
        results = list(executor.map(lambda item: _probe_target(*item, timeout=timeout), targets.items()))
    return {name: result for name, result in results}


def redact_value(value: Any, *, key: str = "", local_usernames: list[str] | None = None) -> Any:
    if SENSITIVE_KEY_RE.search(key) or USERNAME_KEY_RE.search(key):
        return REDACTED
    if isinstance(value, dict):
        return {
            str(child_key): redact_value(
                child_value,
                key=str(child_key),
                local_usernames=local_usernames,
            )
            for child_key, child_value in value.items()
        }
    if isinstance(value, list):
        return [redact_value(item, key=key, local_usernames=local_usernames) for item in value]
    if isinstance(value, tuple):
        return [redact_value(item, key=key, local_usernames=local_usernames) for item in value]
    if isinstance(value, str):
        return redact_text(value, local_usernames=local_usernames)
    return value


def redact_text(text: str, *, local_usernames: list[str] | None = None) -> str:
    sanitized = str(text or "")
    usernames = _local_usernames() | {
        str(item).strip()
        for item in (local_usernames or [])
        if len(str(item).strip()) >= 2
    }
    for username in usernames:
        sanitized = re.sub(re.escape(username), REDACTED, sanitized, flags=re.IGNORECASE)
    for pattern in TEXT_SECRET_PATTERNS:
        sanitized = pattern.sub(lambda match: f"{match.group(1)}{REDACTED}", sanitized)
    return sanitized


def _system_snapshot(
    browser_info: dict[str, Any],
    generated_at: str,
    local_usernames: list[str],
) -> dict[str, Any]:
    return redact_value(
        {
            "generated_at": generated_at,
            "app_version": APP_VERSION,
            "system": platform.platform(),
            "system_name": platform.system(),
            "system_release": platform.release(),
            "machine": platform.machine(),
            "python_version": platform.python_version(),
            "python_implementation": platform.python_implementation(),
            "frozen_bundle": bool(getattr(sys, "frozen", False)),
            "browser": browser_info,
        },
        local_usernames=local_usernames,
    )


def _disk_snapshot(path: Path, local_usernames: list[str]) -> dict[str, Any]:
    usage = shutil.disk_usage(path)
    return {
        "path": redact_text(str(path), local_usernames=local_usernames),
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "free_gib": round(usage.free / (1024 ** 3), 2),
    }


def _probe_target(name: str, url: str, *, timeout: float) -> tuple[str, dict[str, Any]]:
    if not url:
        return name, {"reachable": False, "status": None, "latency_ms": None, "error": "not configured"}
    request = urllib.request.Request(url, headers={"User-Agent": BILIBILI_HEADERS["User-Agent"]}, method="GET")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(256)
            status = int(getattr(response, "status", 200) or 200)
            return name, _connectivity_result(True, status, started, "")
    except urllib.error.HTTPError as exc:
        return name, _connectivity_result(True, int(exc.code), started, f"HTTP {exc.code}")
    except (OSError, urllib.error.URLError) as exc:
        return name, _connectivity_result(False, None, started, redact_text(str(exc)))


def _connectivity_result(reachable: bool, status: int | None, started: float, error: str) -> dict[str, Any]:
    return {
        "reachable": reachable,
        "status": status,
        "latency_ms": round((time.monotonic() - started) * 1000),
        "error": error,
    }


def _collect_configs(local_usernames: list[str]) -> dict[str, Any]:
    configs: dict[str, Any] = {}
    for path in DIAGNOSTIC_CONFIG_FILES:
        if not path.exists() or not path.is_file():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            configs[path.name] = {"error": redact_text(str(exc))}
            continue
        configs[path.name] = redact_value(payload, local_usernames=local_usernames)
    return configs


def _collect_logs(local_usernames: list[str]) -> dict[str, str]:
    if not LOG_DIR.exists():
        return {}
    candidates = sorted(
        (path for path in LOG_DIR.rglob("*") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )[:MAX_LOG_FILES]
    logs: dict[str, str] = {}
    for path in candidates:
        try:
            with path.open("rb") as handle:
                handle.seek(max(0, path.stat().st_size - MAX_LOG_BYTES_PER_FILE))
                raw = handle.read(MAX_LOG_BYTES_PER_FILE)
        except OSError:
            continue
        relative = str(path.relative_to(LOG_DIR)).replace("\\", "__").replace("/", "__")
        logs[relative] = redact_text(
            raw.decode("utf-8", errors="replace"),
            local_usernames=local_usernames,
        )
    return logs


def _build_markdown(
    *,
    system: dict[str, Any],
    tools: dict[str, Any],
    tasks: dict[str, Any],
    policy: dict[str, Any],
    runtime: dict[str, Any],
    disk: dict[str, Any],
    connectivity: dict[str, Any],
    logs: dict[str, str],
) -> str:
    lines = [
        "# Bilikara Diagnostic Report",
        "",
        f"Generated: `{system.get('generated_at', '')}`",
        "",
        "## Environment",
        "",
        f"- App: `{system.get('app_version', '')}`",
        f"- System: `{system.get('system', '')}`",
        f"- Python: `{system.get('python_implementation', '')} {system.get('python_version', '')}`",
        f"- Browser: `{_browser_label(system.get('browser', {}))}`",
        f"- Bundle: `{'yes' if system.get('frozen_bundle') else 'no'}`",
        "",
        "## Tools",
        "",
        "| Tool | Installed | Version | State |",
        "| --- | --- | --- | --- |",
    ]
    for name, item in tools.items():
        lines.append(
            f"| {name} | {'yes' if item.get('installed') else 'no'} | "
            f"{item.get('version') or '-'} | {item.get('state') or '-'} |"
        )
    lines.extend(
        [
            "",
            "## Download Policy",
            "",
            _json_code_block(policy),
            "",
            "## Disk",
            "",
            f"- Free: `{disk.get('free_gib', 0)} GiB`",
            f"- Free bytes: `{disk.get('free_bytes', 0)}`",
            "",
            "## Connectivity",
            "",
            "| Target | Reachable | HTTP | Latency | Error |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    for name, item in connectivity.items():
        lines.append(
            f"| {name} | {'yes' if item.get('reachable') else 'no'} | {item.get('status') or '-'} | "
            f"{item.get('latency_ms', '-')} ms | {item.get('error') or '-'} |"
        )
    lines.extend(
        [
            "",
            "## Recent Tasks",
            "",
            _json_code_block({"cache": tasks, "runtime": runtime}),
        ]
    )
    if logs:
        recent_lines: list[str] = []
        for name, text in logs.items():
            recent_lines.append(f"--- {name} ---")
            recent_lines.extend(text.splitlines()[-MAX_MARKDOWN_LOG_LINES:])
            if len(recent_lines) >= MAX_MARKDOWN_LOG_LINES:
                break
        lines.extend(["", "## Recent Sanitized Logs", "", "```text", *recent_lines[-MAX_MARKDOWN_LOG_LINES:], "```"])
    lines.extend(["", "> Sensitive credentials and local user names are automatically redacted.", ""])
    return "\n".join(lines)


def _browser_label(browser: Any) -> str:
    if not isinstance(browser, dict):
        return "unknown"
    brands = browser.get("brands")
    if isinstance(brands, list):
        labels = [
            f"{item.get('brand')} {item.get('version')}"
            for item in brands
            if isinstance(item, dict) and item.get("brand")
        ]
        if labels:
            return ", ".join(labels)
    return str(browser.get("user_agent") or "unknown")


def _json_code_block(payload: Any) -> str:
    return f"```json\n{json.dumps(payload, ensure_ascii=False, indent=2)}\n```"


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")


def _local_usernames() -> set[str]:
    candidates = {
        getpass.getuser(),
        Path.home().name,
        os.environ.get("USERNAME", ""),
        os.environ.get("USER", ""),
    }
    return {str(item).strip() for item in candidates if len(str(item).strip()) >= 2}
