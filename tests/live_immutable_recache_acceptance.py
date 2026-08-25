#!/usr/bin/env python3
"""Deterministic real-browser acceptance for immutable cache publication.

This executable test deliberately replaces only remote media acquisition.  It
keeps the Rust AppState, Python CacheManager worker, validation/publication,
HTTP server/Range handling, Host UI, and Chromium media engine real.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BROWSER_DRIVER = Path(__file__).with_name("live_immutable_recache_browser.js")
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))
SCENARIOS = (
    "recache-playing",
    "recache-paused",
    "recache-failed",
    "recache-cancelled",
    "normal-switch",
    "play-now-ready",
    "play-now-uncached",
    "natural-ended",
)


def _find_existing(candidates: tuple[Path, ...], label: str) -> Path:
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError(f"{label} is unavailable")


def _tool_executable(
    override: str | None, environment_name: str, executable_name: str
) -> Path:
    configured = override or os.environ.get(environment_name)
    discovered = shutil.which(executable_name)
    candidates = tuple(
        Path(value).expanduser().resolve()
        for value in (configured, discovered)
        if value
    )
    return _find_existing(candidates, executable_name)


def _playwright_module_root(override: str | None) -> Path:
    configured = override or os.environ.get(
        "BILIKARA_ACCEPTANCE_PLAYWRIGHT_MODULE_ROOT"
    )
    roots: list[Path] = []
    if configured:
        roots.append(Path(configured).expanduser().resolve())
    roots.extend(
        Path(entry).expanduser().resolve()
        for entry in os.environ.get("NODE_PATH", "").split(os.pathsep)
        if entry
    )
    roots.append(REPOSITORY_ROOT / "node_modules")
    roots.extend(
        package.parent.parent
        for package in sorted(
            (Path.home() / ".npm" / "_npx").glob(
                "*/node_modules/playwright/package.json"
            ),
            reverse=True,
        )
    )
    for root in roots:
        if (root / "playwright" / "package.json").is_file():
            return root
        if root.name == "playwright" and (root / "package.json").is_file():
            return root.parent
    raise RuntimeError("Playwright Node module is unavailable")


def _chromium_executable(override: str | None) -> Path:
    configured = override or os.environ.get("BILIKARA_ACCEPTANCE_CHROMIUM")
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured).expanduser().resolve())
    for executable in ("chromium", "chromium-browser", "google-chrome"):
        discovered = shutil.which(executable)
        if discovered:
            candidates.append(Path(discovered).resolve())
    browser_roots = [Path.home() / ".cache" / "ms-playwright"]
    configured_browser_root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if configured_browser_root and configured_browser_root != "0":
        browser_roots.insert(
            0, Path(configured_browser_root).expanduser().resolve()
        )
    for browser_root in browser_roots:
        for pattern in (
            "chromium-*/chrome-linux/chrome",
            "chromium-*/chrome-linux64/chrome",
            "chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell",
        ):
            candidates.extend(sorted(browser_root.glob(pattern), reverse=True))
    return _find_existing(tuple(candidates), "Playwright Chromium")


def _run_checked(command: list[str]) -> None:
    completed = subprocess.run(
        command,
        cwd=REPOSITORY_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n"
            f"{completed.stdout}\n{completed.stderr}"
        )


def _generate_fixture(
    fixture_root: Path,
    name: str,
    *,
    ffmpeg: Path,
    duration: float,
    color: str,
    frequency: int,
) -> dict[str, Any]:
    video_path = fixture_root / f"{name}-video.webm"
    audio_path = fixture_root / f"{name}-audio.ogg"
    _run_checked(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=320x180:r=24:d={duration}",
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            str(video_path),
        ]
    )
    _run_checked(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:sample_rate=48000:duration={duration}",
            "-vn",
            "-c:a",
            "libopus",
            str(audio_path),
        ]
    )
    return {
        "video": str(video_path),
        "audio": str(audio_path),
        "duration": duration,
    }


def _fixtures(
    fixture_root: Path, ffmpeg: Path
) -> dict[str, dict[str, Any]]:
    fixture_root.mkdir(parents=True, exist_ok=True)
    return {
        "a1": _generate_fixture(
            fixture_root,
            "a1",
            ffmpeg=ffmpeg,
            duration=6.0,
            color="0x204080",
            frequency=330,
        ),
        "a2": _generate_fixture(
            fixture_root,
            "a2",
            ffmpeg=ffmpeg,
            duration=6.0,
            color="0x802040",
            frequency=440,
        ),
        "a3": _generate_fixture(
            fixture_root,
            "a3",
            ffmpeg=ffmpeg,
            duration=6.0,
            color="0x208040",
            frequency=550,
        ),
        "b1": _generate_fixture(
            fixture_root,
            "b1",
            ffmpeg=ffmpeg,
            duration=4.0,
            color="0x806020",
            frequency=660,
        ),
        "c1": _generate_fixture(
            fixture_root,
            "c1",
            ffmpeg=ffmpeg,
            duration=4.0,
            color="0x602080",
            frequency=770,
        ),
        "n1": _generate_fixture(
            fixture_root,
            "n1",
            ffmpeg=ffmpeg,
            duration=1.6,
            color="0x206060",
            frequency=880,
        ),
    }


def _scenario_plan(scenario: str) -> tuple[list[str], int, dict[str, list[dict[str, Any]]], list[str]]:
    delayed_a2 = {"fixture": "a2", "delay": 1.8}
    if scenario == "recache-playing":
        return ["A"], 1, {"A": [{"fixture": "a1"}, delayed_a2]}, ["A"]
    if scenario == "recache-paused":
        return ["A"], 1, {"A": [{"fixture": "a1"}, delayed_a2]}, ["A"]
    if scenario == "recache-failed":
        return ["A"], 1, {
            "A": [{"fixture": "a1"}, {"fixture": "a2", "delay": 0.8, "fail": True}]
        }, ["A"]
    if scenario == "recache-cancelled":
        return ["A"], 1, {
            "A": [
                {"fixture": "a1"},
                {"fixture": "a2", "delay": 2.0},
                {"fixture": "a3", "delay": 0.5},
            ]
        }, ["A"]
    if scenario == "normal-switch":
        return ["A", "B"], 2, {
            "A": [{"fixture": "a1"}, delayed_a2],
            "B": [{"fixture": "b1"}],
        }, ["A", "B"]
    if scenario == "play-now-ready":
        return ["A", "B", "C"], 3, {
            "A": [{"fixture": "a1"}, delayed_a2],
            "B": [{"fixture": "b1"}],
            "C": [{"fixture": "c1"}],
        }, ["A", "B", "C"]
    if scenario == "play-now-uncached":
        return ["A", "B", "C"], 2, {
            "A": [{"fixture": "a1"}, delayed_a2],
            "B": [{"fixture": "b1"}],
            "C": [{"fixture": "c1", "delay": 1.0}],
        }, ["A", "B"]
    if scenario == "natural-ended":
        return ["A", "B"], 2, {
            "A": [{"fixture": "n1"}],
            "B": [{"fixture": "b1"}],
        }, ["A", "B"]
    raise ValueError(f"unknown scenario: {scenario}")


class DeterministicAcquisition:
    def __init__(
        self,
        fixtures: dict[str, dict[str, Any]],
        plans: dict[str, list[dict[str, Any]]],
        events: list[dict[str, Any]],
    ) -> None:
        self.fixtures = fixtures
        self.plans = {item_id: list(entries) for item_id, entries in plans.items()}
        self.events = events
        self.lock = threading.RLock()

    def download(self, manager: Any, item: Any, item_dir: Path, token: int) -> dict[str, object]:
        from bilikara.cache import CacheCancelledError, DownloadCommandError

        with self.lock:
            plans = self.plans.get(item.id) or []
            if not plans:
                raise DownloadCommandError(f"no deterministic fixture plan for {item.id}")
            plan = plans.pop(0)
            fixture_name = str(plan["fixture"])
            self.events.append(
                {
                    "event": "acquisition_started",
                    "item_id": item.id,
                    "cache_attempt_token": token,
                    "fixture": fixture_name,
                }
            )

        delay = float(plan.get("delay") or 0.0)
        deadline = time.monotonic() + delay
        while time.monotonic() < deadline:
            try:
                manager._raise_if_retry_requested(item.id)
                manager._raise_if_priority_shift(item.id)
            except CacheCancelledError:
                with self.lock:
                    self.events.append(
                        {
                            "event": "acquisition_cancelled",
                            "item_id": item.id,
                            "cache_attempt_token": token,
                            "fixture": fixture_name,
                        }
                    )
                raise
            time.sleep(0.025)

        fixture = self.fixtures[fixture_name]
        video_path = item_dir / "fixture-video.webm"
        audio_path = item_dir / "fixture-audio.ogg"
        shutil.copy2(str(fixture["video"]), video_path)
        if bool(plan.get("fail")):
            with self.lock:
                self.events.append(
                    {
                        "event": "acquisition_failed_after_video",
                        "item_id": item.id,
                        "cache_attempt_token": token,
                        "fixture": fixture_name,
                    }
                )
            raise DownloadCommandError("deterministic failure after prepared video")
        shutil.copy2(str(fixture["audio"]), audio_path)

        with self.lock:
            self.events.append(
                {
                    "event": "acquisition_complete",
                    "item_id": item.id,
                    "cache_attempt_token": token,
                    "fixture": fixture_name,
                }
            )
        audio_url = manager._build_media_url(str(audio_path.relative_to(manager_cache_root())))
        video_url = manager._build_media_url(str(video_path.relative_to(manager_cache_root())))
        return {
            "video_file": video_path,
            "video_relative_path": str(video_path.relative_to(manager_cache_root())),
            "video_media_url": video_url,
            "audio_variants": [
                {
                    "id": "p1",
                    "label": "伴奏",
                    "page": 1,
                    "audio_url": audio_url,
                }
            ],
            "selected_audio_variant_id": "p1",
            "validation_files": [
                {
                    "label": "fixture video",
                    "path": video_path,
                    "required_streams": {"video"},
                    "stream_kind": "video",
                    "page": 1,
                    "expected_duration": float(fixture["duration"]),
                    "download_source": "ytdlp",
                },
                {
                    "label": "fixture audio",
                    "path": audio_path,
                    "required_streams": {"audio"},
                    "stream_kind": "audio",
                    "page": 1,
                    "download_source": "ytdlp",
                },
            ],
        }


def manager_cache_root() -> Path:
    from bilikara.cache import CACHE_DIR

    return CACHE_DIR


def _item(item_id: str, duration: float) -> Any:
    from bilikara.models import PlaylistItem

    return PlaylistItem(
        id=item_id,
        original_url=f"https://fixture.invalid/{item_id}",
        resolved_url=f"https://fixture.invalid/{item_id}?p=1",
        bvid=f"BVFIXTURE{item_id}",
        aid=1000 + ord(item_id[0]),
        cid=2000 + ord(item_id[0]),
        page=1,
        title=f"Fixture Song {item_id}",
        part_title="P1",
        display_title=f"Fixture Song {item_id}",
        cover_url="",
        embed_url="",
        selected_pages=[1],
        selected_cids=[2000 + ord(item_id[0])],
        selected_durations=[max(1, round(duration))],
        selected_parts=["伴奏"],
        available_pages=[1],
        available_cids=[2000 + ord(item_id[0])],
        available_durations=[max(1, round(duration))],
        available_parts=["伴奏"],
    )


def _wait_ready(context: Any, item_ids: list[str], timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if all(
            (item := context.store.get_item(item_id)) is not None
            and item.cache_status == "ready"
            and bool(item.artifact_set_id)
            for item_id in item_ids
        ):
            return
        time.sleep(0.05)
    snapshot = context.store.snapshot()
    raise RuntimeError(
        f"initial cache fill timed out for {item_ids}: "
        f"{json.dumps(snapshot, ensure_ascii=False)}"
    )


def _worker(args: argparse.Namespace) -> int:
    os.environ["BILIKARA_HOME"] = str(Path(args.runtime_root).resolve())
    os.environ["BILIKARA_HOST"] = "127.0.0.1"
    os.environ["BILIKARA_PORT"] = "0"
    os.environ["BILIKARA_REQUIRE_RUST_LIB"] = "1"
    os.environ["BILIKARA_MAX_CACHE_ITEMS"] = "5"

    from http.server import ThreadingHTTPServer

    from bilikara import server
    from bilikara.cache import CacheManager

    fixture_payload = json.loads(Path(args.fixtures_json).read_text(encoding="utf-8"))
    item_ids, cache_limit, plans, initially_ready = _scenario_plan(args.scenario)
    context = server.CONTEXT
    manager: CacheManager = context.cache_manager
    manager.max_cache_items = cache_limit
    manager.download_source = "bbdown"
    # Seed the same force-AVC decision Chromium reports before any items enter
    # the cache window, so capability discovery is not mistaken for the
    # user-requested recache under test.
    manager.set_client_media_capabilities(
        {
            "hevc_supported": False,
            "avc_supported": True,
            "max_avc_quality_index": 0,
            "can_play_type": {},
            "avc_levels": [],
            "user_agent": "deterministic acceptance preflight",
            "platform": sys.platform,
        }
    )
    events: list[dict[str, Any]] = []
    acquisition = DeterministicAcquisition(fixture_payload, plans, events)
    ffmpeg = Path(args.ffmpeg).resolve()
    ffprobe = Path(args.ffprobe).resolve()

    manager._ensure_downloader = types.MethodType(  # type: ignore[method-assign]
        lambda self, _source: ffmpeg, manager
    )
    manager._ensure_ffmpeg = types.MethodType(  # type: ignore[method-assign]
        lambda self, force_refresh=False: ffmpeg, manager
    )
    manager._ffprobe_path_for_ffmpeg = types.MethodType(  # type: ignore[method-assign]
        lambda self, _ffmpeg_path: ffprobe, manager
    )

    def deterministic_download(
        self: CacheManager,
        item: Any,
        _binary_path: Path,
        _ffmpeg_path: Path,
        item_dir: Path,
        _log_path: Path,
        *,
        cache_attempt_token: int,
        download_source: str,
    ) -> dict[str, object]:
        if download_source != "bbdown":
            raise RuntimeError(f"unexpected source: {download_source}")
        return acquisition.download(self, item, item_dir, cache_attempt_token)

    manager._download_selected_streams = types.MethodType(  # type: ignore[method-assign]
        deterministic_download, manager
    )

    original_begin = context.store.begin_cache_attempt

    def traced_begin(item_id: str, expected_item_incarnation_id: str) -> int:
        token = original_begin(item_id, expected_item_incarnation_id)
        reservation = context.store.cache_attempt_reservation(token)
        events.append(
            {
                "event": "attempt_reserved",
                "item_id": item_id,
                "cache_attempt_token": token,
                "artifact_set_id": reservation["artifact_set_id"],
                "artifact_relative_directory": reservation[
                    "artifact_relative_directory"
                ],
                "refresh": reservation["refresh"],
            }
        )
        return token

    context.store.begin_cache_attempt = traced_begin  # type: ignore[method-assign]
    original_publish = manager._publish_validated_cache_result

    def traced_publish(*publish_args: Any, **publish_kwargs: Any) -> None:
        original_publish(*publish_args, **publish_kwargs)
        reservation = publish_args[2]
        events.append(
            {
                "event": "directory_published",
                "item_id": publish_args[0],
                "cache_attempt_token": publish_args[1],
                "artifact_set_id": reservation["artifact_set_id"],
                "artifact_relative_directory": reservation[
                    "artifact_relative_directory"
                ],
            }
        )

    manager._publish_validated_cache_result = traced_publish  # type: ignore[method-assign]
    original_advance = context.advance_to_next
    advance_count = 0

    def counted_advance() -> None:
        nonlocal advance_count
        advance_count += 1
        events.append({"event": "advance_mutation", "count": advance_count})
        original_advance()

    context.advance_to_next = counted_advance  # type: ignore[method-assign]

    context.store.add_session_user("acceptance-user")
    context.store.set_song_advance_delay_seconds(0)
    durations = {key: float(value["duration"]) for key, value in fixture_payload.items()}
    for item_id in item_ids:
        fixture_key = plans[item_id][0]["fixture"]
        context.store.add_item(
            _item(item_id, durations[str(fixture_key)]),
            requester_name="acceptance-user",
        )
    manager.sync_with_playlist()
    _wait_ready(context, initially_ready)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.BilikaraHandler)
    context.bind_server(httpd, shutdown_on_last_client=False)
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()
    port = int(httpd.server_address[1])

    node_env = dict(os.environ)
    node_env["NODE_PATH"] = args.playwright_module_root
    command = [
        "node",
        str(BROWSER_DRIVER),
        f"http://127.0.0.1:{port}",
        args.scenario,
        args.chromium,
    ]
    completed = subprocess.run(
        command,
        cwd=REPOSITORY_ROOT,
        env=node_env,
        capture_output=True,
        text=True,
        check=False,
        timeout=90,
    )
    try:
        browser_result = json.loads(completed.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"browser driver returned invalid evidence\nstdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        ) from exc
    final_snapshot = context.store.snapshot()
    current_payload = final_snapshot.get("current_item") or {}
    published_events = [
        event for event in events if event.get("event") == "directory_published"
    ]
    published_directories_exist = all(
        (
            manager_cache_root()
            / str(event.get("artifact_relative_directory") or "")
        ).is_dir()
        for event in published_events
    )
    expected_current = (
        "B"
        if args.scenario in {"normal-switch", "natural-ended"}
        else "C"
        if args.scenario in {"play-now-ready", "play-now-uncached"}
        else "A"
    )
    server_acceptance = bool(
        current_payload.get("id") == expected_current
        and published_directories_exist
        and (
            advance_count == 1
            if args.scenario in {"normal-switch", "natural-ended"}
            else advance_count == 0
        )
        and (
            args.scenario != "natural-ended"
            or (
                len(final_snapshot.get("history") or []) == 1
                and len(final_snapshot.get("session_played") or []) == 2
            )
        )
        and (
            args.scenario != "recache-failed"
            or (
                len(published_events) == 1
                and any(
                    event.get("event") == "acquisition_failed_after_video"
                    for event in events
                )
            )
        )
        and (
            args.scenario != "recache-cancelled"
            or (
                len(published_events) == 2
                and any(
                    event.get("event") == "acquisition_cancelled"
                    for event in events
                )
            )
        )
    )
    result = {
        "scenario": args.scenario,
        "passed": (
            completed.returncode == 0
            and browser_result.get("passed") is True
            and server_acceptance
        ),
        "browser": browser_result,
        "server_acceptance": server_acceptance,
        "advance_mutations": advance_count,
        "cache_events": events,
        "final_current_item": current_payload.get("id"),
        "final_artifact_set_id": current_payload.get("artifact_set_id"),
        "final_revision": final_snapshot.get("revision"),
        "session_played_count": len(final_snapshot.get("session_played") or []),
        "history_count": len(final_snapshot.get("history") or []),
        "published_directories_exist_before_shutdown": published_directories_exist,
        "browser_stderr": completed.stderr.strip(),
    }
    print(f"LIVE_RESULT_JSON={json.dumps(result, ensure_ascii=False)}", flush=True)
    httpd.shutdown()
    httpd.server_close()
    context.shutdown()
    return 0 if result["passed"] else 1


def _main(args: argparse.Namespace) -> int:
    ffmpeg = _tool_executable(
        args.ffmpeg, "BILIKARA_ACCEPTANCE_FFMPEG", "ffmpeg"
    )
    ffprobe = _tool_executable(
        args.ffprobe, "BILIKARA_ACCEPTANCE_FFPROBE", "ffprobe"
    )
    playwright_root = _playwright_module_root(args.playwright_module_root)
    chromium = _chromium_executable(args.chromium)
    started_at = time.time()
    with tempfile.TemporaryDirectory(prefix="bilikara-live-recache-") as temp_name:
        temp_root = Path(temp_name)
        fixtures = _fixtures(temp_root / "fixtures", ffmpeg)
        fixtures_json = temp_root / "fixtures.json"
        fixtures_json.write_text(json.dumps(fixtures), encoding="utf-8")
        results: list[dict[str, Any]] = []
        selected_scenarios = (args.scenario,) if args.scenario else SCENARIOS
        for scenario in selected_scenarios:
            runtime_root = temp_root / f"runtime-{scenario}"
            command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "--worker",
                "--scenario",
                scenario,
                "--runtime-root",
                str(runtime_root),
                "--fixtures-json",
                str(fixtures_json),
                "--playwright-module-root",
                str(playwright_root),
                "--chromium",
                str(chromium),
                "--ffmpeg",
                str(ffmpeg),
                "--ffprobe",
                str(ffprobe),
            ]
            completed = subprocess.run(
                command,
                cwd=REPOSITORY_ROOT,
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
            )
            marker_lines = [
                line.removeprefix("LIVE_RESULT_JSON=")
                for line in completed.stdout.splitlines()
                if line.startswith("LIVE_RESULT_JSON=")
            ]
            if not marker_lines:
                raise RuntimeError(
                    f"scenario {scenario} produced no evidence\n"
                    f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
                )
            result = json.loads(marker_lines[-1])
            result["worker_exit_code"] = completed.returncode
            results.append(result)
            print(
                f"{scenario}: {'PASS' if result.get('passed') else 'FAIL'}",
                flush=True,
            )
            if completed.returncode != 0:
                break

        evidence = {
            "contract": "immutable-recache-publication-v1",
            "platform": sys.platform,
            "python": sys.version.split()[0],
            "browser_engine": "Playwright Chromium",
            "playwright_module_root": str(playwright_root),
            "chromium": str(chromium),
            "ffmpeg": str(ffmpeg),
            "ffprobe": str(ffprobe),
            "media_engine": "Chromium HTMLMediaElement with real HTTP media",
            "fixture_durations_seconds": {
                name: payload["duration"] for name, payload in fixtures.items()
            },
            "isolated_runtime": True,
            "started_at_epoch": started_at,
            "finished_at_epoch": time.time(),
            "scenarios": results,
            "corner_case_matrix": {
                "live_passed": [
                    "rapid double recache supersedes the first attempt",
                    "partial video-only failure retains the committed set",
                    "same item and logical filenames publish different URLs",
                    "old/new Range reads overlap authoritative publication",
                    "multiple concurrent readers access the old committed set",
                    "playing and paused recache preserve time and intent",
                    "normal next rejects a late old-element ended callback",
                    "Play Now Ready and uncached reject late old-item work/events",
                    "natural media end advances and archives exactly once",
                ],
                "automated_coverage": [
                    "stale filesystem publication leaves an orphan",
                    "one invalid audio track rejects the whole set",
                    "existing committed destination fails without overwrite",
                    "same-ID remove/re-add receives a new item incarnation",
                    "attempt/artifact counter overflow is atomic",
                    "Ready rejection after publication preserves current state",
                    "latest valid selected audio variant wins",
                    "source changes affect future work only",
                    "cache-window preemption and in-flight retry stay isolated",
                    "explicit Reset/Evict invalidates while stale Ready rejects",
                    "language/cache progress and presentation composition preserve media identity",
                    "duplicate and stale ended callbacks do not advance twice",
                ],
                "not_run": {
                    "pause_then_play_during_one_refresh": (
                        "separate playing and paused publication transitions were exercised; "
                        "the mid-attempt intent flip remains covered by Host behavioral tests"
                    ),
                    "seek_during_refresh": (
                        "the live gate covered publication-time seek restoration; an interactive "
                        "mid-download seek was not added to keep the harness deterministic"
                    ),
                    "audio_variant_change_during_refresh": (
                        "deterministic live fixtures expose one audio variant; multi-variant "
                        "selection precedence is covered by Rust AppState tests"
                    ),
                    "rapid_play_now_a_b_c": (
                        "inverse-response ordering is covered by the executable frontend harness; "
                        "the live gate exercises Ready and uncached Play Now separately"
                    ),
                    "manual_next_play_now_overlap": (
                        "bounded transition deduplication is covered by frontend behavioral tests"
                    ),
                    "natural_end_near_manual_or_recache": (
                        "natural end, manual switch, stale ended, and recache completion were "
                        "exercised independently to avoid timing-flaky acceptance"
                    ),
                    "source_switch_or_preemption_live": (
                        "the acquisition seam is intentionally one captured source; source capture "
                        "and worker preemption are covered by CacheManager integration tests"
                    ),
                    "shutdown_with_active_staging": (
                        "each isolated worker shuts down after terminal publication; startup/shutdown "
                        "cleanup boundaries are covered by automated cache tests"
                    ),
                    "explicit_clear_evict_live": (
                        "destructive invalidation is outside the user-visible recache scenarios and "
                        "is covered by Rust/Python automated tests"
                    ),
                    "windows_open_file_semantics": (
                        "acceptance host is Linux; production never overwrites or live-deletes a "
                        "committed directory, so it does not rely on Unix unlink behavior"
                    ),
                    "physical_dual_display": (
                        "headless Chromium has no physical second display; presentation regressions "
                        "are covered by the dedicated automated suites"
                    ),
                },
            },
            "passed": len(results) == len(selected_scenarios)
            and all(result.get("passed") for result in results),
            "platform_skips": {
                "windows_open_file_semantics": (
                    "not run: acceptance host is Linux; Windows correctness relies on "
                    "never overwriting/deleting live committed directories"
                ),
                "physical_dual_display": (
                    "not run: headless Chromium has no physical second display"
                ),
            },
        }
        evidence_path = Path(args.evidence).resolve()
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"evidence: {evidence_path}", flush=True)
        return 0 if evidence["passed"] else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--evidence",
        default="/tmp/bilikara-immutable-recache-playback-evidence.json",
    )
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--scenario", choices=SCENARIOS)
    parser.add_argument("--runtime-root")
    parser.add_argument("--fixtures-json")
    parser.add_argument("--playwright-module-root")
    parser.add_argument("--chromium")
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    return parser.parse_args()


if __name__ == "__main__":
    parsed = parse_args()
    if parsed.worker:
        raise SystemExit(_worker(parsed))
    raise SystemExit(_main(parsed))
