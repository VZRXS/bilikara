from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

import bilikara.bilibili as bilibili
import bilikara.lark_pool_client as pool_client
from bilikara.config import DATA_DIR
from bilikara.lark_pool_client import append_cloudflare_pool_entries


ROOT_DIR = Path(__file__).resolve().parent
DEFAULT_UIDS_PATH = DATA_DIR / "gatcha_uids.json"
VALID_BVID_RE = re.compile(r"^BV[0-9A-Za-z]{10}$")
_LOCAL_RUN_LOCK = threading.Lock()
_LOCAL_RUN_ACTIVE = False


def _normalize_uid(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.search(r"space\.bilibili\.com/(\d+)", text)
    if match:
        return match.group(1).lstrip("0") or "0"
    match = re.search(r"\b(\d{2,})\b", text)
    if match:
        return match.group(1).lstrip("0") or "0"
    return text if text.isdigit() else ""


def _dedupe_ordered(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = _normalize_uid(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _load_uid_lines(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        text = path.read_text(encoding="utf-8", errors="replace")
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.strip().startswith("#") and not line.strip().startswith("//")
    ]


def _load_configured_uids(path: Path) -> list[str]:
    if path.suffix.lower() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            raw_uids = payload.get("uids")
            if isinstance(raw_uids, list):
                return _dedupe_ordered([str(uid) for uid in raw_uids])
            raw_cache = payload.get("uids")
            if isinstance(raw_cache, dict):
                return _dedupe_ordered(list(raw_cache.keys()))
        if isinstance(payload, list):
            return _dedupe_ordered([str(uid) for uid in payload])
        raise ValueError(f"Unsupported UID JSON shape: {path}")
    return _dedupe_ordered(_load_uid_lines(path))


def _request_json(url: str, *, secret: str = "", timeout: float = 60.0) -> Any:
    headers = {
        "Accept": "application/json",
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "User-Agent": (
            f"bilikara/{getattr(pool_client.cfg, 'APP_VERSION', 'dev')} "
            "(+https://github.com/VZRXS/bilikara)"
        ),
    }
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _export_d1_records(*, api_url: str, secret: str, limit: int, timeout: float) -> list[dict]:
    if not secret:
        raise RuntimeError("BILIKARA_ADMIN_SECRET is required to export D1 records.")
    base_url = str(api_url or "").rstrip("/")
    if not base_url:
        raise RuntimeError("BILIKARA_CF_API_URL is empty.")
    query = urllib.parse.urlencode({"all": "1", "limit": max(1, int(limit)), "_": int(time.time() * 1000)})
    payload = _request_json(f"{base_url}/export?{query}", secret=secret, timeout=timeout)
    if not isinstance(payload, list):
        raise RuntimeError("D1 export returned an invalid payload.")
    return [record for record in payload if isinstance(record, dict)]


def _d1_sets(records: list[dict]) -> tuple[set[str], set[str]]:
    bvids: set[str] = set()
    mids: set[str] = set()
    for record in records:
        bvid = str(record.get("bvid") or "").strip()
        mid = _normalize_uid(record.get("mid"))
        if VALID_BVID_RE.fullmatch(bvid):
            bvids.add(bvid)
        if mid:
            mids.add(mid)
    return bvids, mids


def _fetch_uid_page(mid: str, page_number: int = 1) -> tuple[list[dict], int]:
    payload = bilibili._request_gatcha_page(mid, page_number, 50)  # type: ignore[attr-defined]
    data = payload.get("data", {}) if isinstance(payload, dict) else {}
    page = data.get("page") if isinstance(data, dict) else {}
    total = 0
    if isinstance(page, dict):
        try:
            total = int(page.get("count") or 0)
        except (TypeError, ValueError):
            total = 0
    entries = bilibili._extract_gatcha_entries(mid, payload)  # type: ignore[attr-defined]
    return [entry for entry in entries if isinstance(entry, dict)], total


def _fetch_uid_page_with_retry(
    mid: str,
    page_number: int,
    *,
    retry_delay: float,
    max_retries: int,
) -> tuple[list[dict], int]:
    attempts = 0
    while True:
        try:
            return _fetch_uid_page(mid, page_number)
        except Exception as exc:
            attempts += 1
            if max_retries > 0 and attempts > max_retries:
                raise
            print(
                f"  Bilibili page retry uid={mid} page={page_number} "
                f"attempt={attempts} error={exc}",
                flush=True,
            )
            if retry_delay > 0:
                time.sleep(retry_delay)


def _entry_bvids(entries: list[dict]) -> list[str]:
    bvids: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        bvid = str(entry.get("bvid") or "").strip()
        if VALID_BVID_RE.fullmatch(bvid) and bvid not in seen:
            seen.add(bvid)
            bvids.append(bvid)
    return bvids


def _needs_refresh(first_page_entries: list[dict], d1_bvids: set[str], *, probe_mode: str) -> tuple[bool, str]:
    bvids = _entry_bvids(first_page_entries)
    if not bvids:
        return False, "first page has no visible BV"
    if probe_mode == "page-any":
        missing = [bvid for bvid in bvids if bvid not in d1_bvids]
        if missing:
            return True, f"{len(missing)} BV(s) missing from first page; first={missing[0]}"
        return False, "all first-page BVs are already in D1"
    latest = bvids[0]
    if latest not in d1_bvids:
        return True, f"latest BV missing from D1: {latest}"
    return False, f"latest BV already in D1: {latest}"


def _fetch_all_uid_entries(mid: str, *, retry_delay: float, max_retries: int) -> list[dict]:
    page_size = 50
    page_number = 1
    entries: list[dict] = []
    seen_bvids: set[str] = set()
    while True:
        page_entries, _visible_total = _fetch_uid_page_with_retry(
            mid,
            page_number,
            retry_delay=retry_delay,
            max_retries=max_retries,
        )
        for entry in page_entries:
            bvid = str(entry.get("bvid") or "").strip()
            if not bvid or bvid in seen_bvids:
                continue
            seen_bvids.add(bvid)
            entries.append(entry)
        if len(page_entries) < page_size:
            break
        page_number += 1
    return entries


def _upload_entries(entries: list[dict], *, dry_run: bool) -> dict[str, Any]:
    if dry_run:
        return {"attempted": len(entries), "added": 0, "updated_existing": 0, "dry_run": True}
    return append_cloudflare_pool_entries(entries)


def _combine_uids(local_uids: list[str], d1_mids: set[str], *, uid_mode: str) -> list[str]:
    if uid_mode == "local":
        return list(local_uids)
    if uid_mode == "d1":
        return _dedupe_ordered(sorted(d1_mids, key=lambda value: int(value) if value.isdigit() else value))
    return _dedupe_ordered([*local_uids, *sorted(d1_mids, key=lambda value: int(value) if value.isdigit() else value)])


def main(argv: list[str] | None = None, *, secret_override: str = "") -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Monthly full-UID D1 refresh: export D1 once, probe each UID's first Bilibili page, "
            "and fully refresh only UIDs whose latest visible BV is missing from D1."
        ),
    )
    parser.add_argument("--uid-source", default=str(DEFAULT_UIDS_PATH), help="UID JSON/text file. Default: data/gatcha_uids.json")
    parser.add_argument(
        "--uid-mode",
        choices=("union", "local", "d1"),
        default="union",
        help="Which UID list to process: local file, D1 exported mids, or their union. Default: union.",
    )
    parser.add_argument(
        "--api-url",
        default=str(getattr(pool_client, "_CLOUDFLARE_API_URL", "") or ""),
        help="Cloudflare Worker API URL. Default: BILIKARA_CF_API_URL or https://api.kevinx96.icu",
    )
    parser.add_argument("--limit-uids", type=int, default=0, help="Only process the first N UIDs, for testing.")
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds to sleep after each UID. Default: 2.")
    parser.add_argument("--export-limit", type=int, default=5000, help="D1 export page size used by the Worker. Default: 5000.")
    parser.add_argument("--export-timeout", type=float, default=120.0, help="Seconds before D1 export times out. Default: 120.")
    parser.add_argument(
        "--max-visible-total",
        type=int,
        default=8000,
        help="Skip full refresh when the first Bilibili page reports more than this many submissions. Use 0 to disable. Default: 8000.",
    )
    parser.add_argument(
        "--bili-retry-delay",
        type=float,
        default=float(getattr(bilibili, "GATCHA_RETRY_DELAY_SECONDS", 5.0)),
        help="Seconds to wait before retrying a failed Bilibili UID page request. Default: 5.",
    )
    parser.add_argument(
        "--bili-max-retries",
        type=int,
        default=3,
        help="Retry count per Bilibili page before skipping the UID. Use 0 for unlimited retries. Default: 3.",
    )
    parser.add_argument(
        "--probe-mode",
        choices=("latest", "page-any"),
        default="latest",
        help="latest checks only the newest visible BV; page-any refreshes if any first-page BV is missing.",
    )
    parser.add_argument("--force", action="store_true", help="Refresh and upload every UID without first-page D1 comparison.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and decide, but do not upload to D1.")
    args = parser.parse_args(argv)

    uid_source = Path(args.uid_source).expanduser()
    if uid_source.exists():
        local_uids = _load_configured_uids(uid_source)
    elif args.uid_mode == "local":
        print(f"UID source does not exist: {uid_source}", file=sys.stderr)
        return 2
    else:
        local_uids = []

    secret = str(secret_override or os.environ.get("BILIKARA_ADMIN_SECRET") or "").strip()
    api_url = str(args.api_url or "").rstrip("/")
    try:
        records = _export_d1_records(api_url=api_url, secret=secret, limit=args.export_limit, timeout=args.export_timeout)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace").strip()
        except Exception:
            body = ""
        if exc.code in {401, 403}:
            print(
                "D1 export unauthorized. "
                f"api_url={api_url or '<empty>'} "
                f"secret_len={len(secret)} "
                "This secret must match the Cloudflare Worker BILIKARA_ADMIN_SECRET, not only the local app secret.",
                file=sys.stderr,
            )
            if body:
                print(f"Response body: {body[:500]}", file=sys.stderr)
        else:
            print(f"D1 export failed: HTTP {exc.code} {exc.reason}: {body[:500]}", file=sys.stderr)
        return 2
    except (OSError, urllib.error.URLError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"D1 export failed: {exc}", file=sys.stderr)
        return 2

    d1_bvids, d1_mids = _d1_sets(records)
    uids = _combine_uids(local_uids, d1_mids, uid_mode=args.uid_mode)
    if args.limit_uids > 0:
        uids = uids[: args.limit_uids]
    if not uids:
        print("No UID found.")
        return 0
    local_mids = set(uids)
    local_only_mids = set(local_uids) - d1_mids
    d1_only_mids = d1_mids - set(local_uids)
    print(
        "Loaded "
        f"uid_mode={args.uid_mode} "
        f"process_uids={len(uids)} "
        f"process_unique_mids={len(local_mids)} "
        f"local_uids={len(local_uids)} "
        f"local_unique_mids={len(set(local_uids))} "
        f"d1_records={len(records)} "
        f"d1_unique_mids={len(d1_mids)} "
        f"d1_unique_bvids={len(d1_bvids)} "
        f"local_only_mids={len(local_only_mids)} "
        f"d1_only_mids={len(d1_only_mids)}",
        flush=True,
    )

    refreshed = 0
    skipped = 0
    failed: list[tuple[str, str]] = []
    started_at = time.monotonic()

    for index, mid in enumerate(uids, start=1):
        print(f"[{index}/{len(uids)}] probe uid={mid}", flush=True)
        try:
            first_page_entries, visible_total = _fetch_uid_page_with_retry(
                mid,
                1,
                retry_delay=args.bili_retry_delay,
                max_retries=args.bili_max_retries,
            )
            should_refresh, reason = (
                (True, "forced")
                if args.force
                else _needs_refresh(first_page_entries, d1_bvids, probe_mode=args.probe_mode)
            )
            print(f"  first_page={len(first_page_entries)} visible_total={visible_total} {reason}", flush=True)
            if args.max_visible_total > 0 and visible_total > args.max_visible_total:
                skipped += 1
                print(
                    f"  skip full refresh: visible_total={visible_total} exceeds max_visible_total={args.max_visible_total}",
                    flush=True,
                )
                continue
            if not should_refresh:
                skipped += 1
                continue

            entries = _fetch_all_uid_entries(
                mid,
                retry_delay=args.bili_retry_delay,
                max_retries=args.bili_max_retries,
            )
            upload = _upload_entries(entries, dry_run=args.dry_run)
            for bvid in _entry_bvids(entries):
                d1_bvids.add(bvid)
            refreshed += 1
            print(
                "  refreshed "
                f"entries={len(entries)} "
                f"d1_attempted={upload.get('attempted', 0)} "
                f"d1_added={upload.get('added', 0)} "
                f"d1_updated={upload.get('updated_existing', 0)}",
                flush=True,
            )
            if upload.get("error"):
                raise RuntimeError(str(upload["error"]))
        except KeyboardInterrupt:
            print("\nInterrupted by user.", file=sys.stderr)
            return 130
        except Exception as exc:  # noqa: BLE001
            failed.append((mid, str(exc)))
            print(f"  failed: {exc}", file=sys.stderr, flush=True)

        if args.delay > 0 and index < len(uids):
            time.sleep(args.delay)

    print(
        "Done. "
        f"refreshed={refreshed} skipped={skipped} failed={len(failed)} "
        f"elapsed={time.monotonic() - started_at:.1f}s",
        flush=True,
    )
    if failed:
        print("Failed UIDs:", file=sys.stderr)
        for mid, error in failed:
            print(f"  {mid}: {error}", file=sys.stderr)
        return 1
    return 0


def start_monthly_refresh_in_background(
    secret: str,
    *,
    requested_by: str = "",
) -> dict[str, Any]:
    """Start the restored v0.7 maintenance script inside the local Host."""

    global _LOCAL_RUN_ACTIVE
    normalized_secret = str(secret or "").strip()
    if not normalized_secret:
        return {
            "success": False,
            "job": "monthly-d1-refresh",
            "error": "missing secret",
        }
    with _LOCAL_RUN_LOCK:
        if _LOCAL_RUN_ACTIVE:
            return {
                "success": False,
                "job": "monthly-d1-refresh",
                "error": "monthly D1 refresh is already running locally",
            }
        _LOCAL_RUN_ACTIVE = True

    instance_id = f"local-monthly-{int(time.time())}"

    def run() -> None:
        global _LOCAL_RUN_ACTIVE
        try:
            requester = str(requested_by or "").strip()[:120]
            if requester:
                print(f"Monthly D1 refresh requested locally by {requester}.", flush=True)
            exit_code = main([], secret_override=normalized_secret)
            if exit_code:
                print(f"Monthly D1 refresh exited with code {exit_code}.", file=sys.stderr, flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"Monthly D1 refresh failed: {exc}", file=sys.stderr, flush=True)
        finally:
            with _LOCAL_RUN_LOCK:
                _LOCAL_RUN_ACTIVE = False

    worker = threading.Thread(
        target=run,
        daemon=True,
        name="bilikara-monthly-d1-refresh",
    )
    try:
        worker.start()
    except Exception as exc:  # noqa: BLE001
        with _LOCAL_RUN_LOCK:
            _LOCAL_RUN_ACTIVE = False
        return {
            "success": False,
            "job": "monthly-d1-refresh",
            "error": f"failed to start local monthly D1 refresh: {str(exc)[:240]}",
        }
    return {
        "success": True,
        "job": "monthly-d1-refresh",
        "instance_id": instance_id,
        "status": "running",
        "execution": "local",
    }


if __name__ == "__main__":
    raise SystemExit(main())
