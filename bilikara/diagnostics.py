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
    export_diagnostics: list[dict[str, Any]] | None = None,
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
    sanitized_export = _sanitize_export_diagnostics(export_diagnostics, local_usernames=redaction_names)
    configs = _collect_configs(redaction_names)
    logs = _collect_logs(redaction_names)

    files: dict[str, bytes] = {
        "system.json": _json_bytes(system),
        "tools-and-tasks.json": _json_bytes(sanitized_tools),
        "download-policy.json": _json_bytes(sanitized_policy),
        "runtime-state.json": _json_bytes(sanitized_runtime),
        "disk.json": _json_bytes(disk),
        "connectivity.json": _json_bytes(connectivity),
        "export-diagnostics.json": _json_bytes(sanitized_export),
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
        export_diagnostics=sanitized_export,
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


def _sanitize_export_diagnostics(
    raw_list: Any,
    local_usernames: list[str] | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(raw_list, list):
        return []

    sanitized_items: list[dict[str, Any]] = []
    for item in raw_list[-64:]:
        if not isinstance(item, dict):
            continue
        try:
            timestamp = str(item.get("timestamp") or "").strip()[:64]
            surface = str(item.get("surface") or "").strip()[:32]
            runtime = str(item.get("runtime") or "").strip()[:32]
            format_val = str(item.get("format"))[:32] if item.get("format") is not None else None
            source_val = str(item.get("source"))[:64] if item.get("source") is not None else None

            page_size = item.get("pageSize")
            if page_size is not None and not isinstance(page_size, bool):
                try:
                    page_size = int(page_size)
                except (ValueError, TypeError):
                    page_size = None
            else:
                page_size = None

            stage = str(item.get("stage"))[:64] if item.get("stage") is not None else None
            status = str(item.get("status"))[:32] if item.get("status") is not None else None

            http_status = item.get("httpStatus")
            if http_status is not None and not isinstance(http_status, bool):
                try:
                    http_status = int(http_status)
                except (ValueError, TypeError):
                    http_status = None
            else:
                http_status = None

            content_type = str(item.get("contentType"))[:128] if item.get("contentType") is not None else None

            bytes_val = item.get("bytes")
            if bytes_val is not None and not isinstance(bytes_val, bool):
                try:
                    bytes_val = int(bytes_val)
                except (ValueError, TypeError):
                    bytes_val = None
            else:
                bytes_val = None

            filename_ext = str(item.get("filenameExtension"))[:32] if item.get("filenameExtension") is not None else None

            elapsed_ms = item.get("elapsedMs")
            if elapsed_ms is not None and not isinstance(elapsed_ms, bool):
                try:
                    elapsed_ms = int(elapsed_ms)
                except (ValueError, TypeError):
                    elapsed_ms = None
            else:
                elapsed_ms = None

            stage_timings = None
            raw_timings = item.get("stageTimings")
            if isinstance(raw_timings, list):
                valid_timings = []
                for t in raw_timings[:16]:
                    if isinstance(t, dict) and "stage" in t:
                        t_stage = str(t.get("stage"))[:64]
                        t_ms = t.get("elapsedMs")
                        if t_ms is not None and not isinstance(t_ms, bool):
                            try:
                                t_ms = int(t_ms)
                            except (ValueError, TypeError):
                                t_ms = 0
                        else:
                            t_ms = 0
                        valid_timings.append({"stage": t_stage, "elapsedMs": t_ms})
                stage_timings = valid_timings

            error_code = str(item.get("errorCode"))[:256] if item.get("errorCode") is not None else None
            error_msg = str(item.get("errorMessage"))[:256] if item.get("errorMessage") is not None else None

            raw_req_id = item.get("requestId") or item.get("request_id")
            request_id = str(raw_req_id).strip()[:64] if raw_req_id else None

            image_export_timings = _sanitize_image_export_timings(
                item.get("imageExportTimings") or item.get("image_export_timings")
            )

            sanitized_entry = {
                "timestamp": timestamp,
                "surface": surface,
                "runtime": runtime,
                "format": format_val,
                "source": source_val,
                "pageSize": page_size,
                "stage": stage,
                "status": status,
                "httpStatus": http_status,
                "contentType": content_type,
                "bytes": bytes_val,
                "filenameExtension": filename_ext,
                "elapsedMs": elapsed_ms,
                "stageTimings": stage_timings,
                "requestId": request_id,
                "imageExportTimings": image_export_timings,
                "errorCode": error_code,
                "errorMessage": error_msg,
            }

            redacted_entry = redact_value(sanitized_entry, local_usernames=local_usernames)
            sanitized_items.append(redacted_entry)
        except Exception:
            continue

    return sanitized_items


def _sanitize_image_export_timings(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    timing_keys = (
        "pillow_import",
        "prepare_items_and_pages",
        "font_discovery",
        "font_load",
        "font_cmap_cold_parse_ms",
        "font_cmap_cold_miss_count",
        "font_cmap_cold_bytes_read",
        "page_count",
        "page_render_total_ms",
        "page_render_max_ms",
        "png_encode_total_ms",
        "zip_write_finalize_ms",
        "total_image_export",
    )
    result: dict[str, Any] = {}
    for key in timing_keys:
        val = raw.get(key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            result[key] = round(float(val), 1) if isinstance(val, float) else val
    return result if result else None


def _build_markdown(
    *,
    system: dict[str, Any],
    tools: dict[str, Any],
    tasks: dict[str, Any],
    policy: dict[str, Any],
    runtime: dict[str, Any],
    disk: dict[str, Any],
    connectivity: dict[str, Any],
    export_diagnostics: list[dict[str, Any]] | None = None,
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
            "",
            "## Recent Export Pipeline Diagnostics",
            "",
        ]
    )
    if export_diagnostics:
        lines.extend(
            [
                "| Timestamp | Surface | Runtime | Format | Status | Stage | HTTP | Bytes | Elapsed | Error |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
            ]
        )
        for item in export_diagnostics:
            err_str = item.get("errorMessage") or item.get("errorCode") or "-"
            lines.append(
                f"| {item.get('timestamp') or '-'} | {item.get('surface') or '-'} | "
                f"{item.get('runtime') or '-'} | {item.get('format') or '-'} | "
                f"{item.get('status') or '-'} | {item.get('stage') or '-'} | "
                f"{item.get('httpStatus') or '-'} | {item.get('bytes') or '-'} | "
                f"{item.get('elapsedMs', '-')} ms | {err_str} |"
            )
    else:
        lines.append("No recent export attempts recorded.")

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
