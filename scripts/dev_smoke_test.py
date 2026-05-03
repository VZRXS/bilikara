#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except AttributeError:
    pass

CLIENT_ID = "dev-smoke-test-host"
REMOTE_CLIENT_ID = "dev-smoke-test-remote"
GATCHA_MULTI_PAGE_QUERY = "\u679c\u53a8"
DEFAULT_BBDOWN_TIMEOUT_SECONDS = 300
DEFAULT_CACHE_TIMEOUT_SECONDS = 420
DEFAULT_VISUAL_PAUSE_SECONDS = 5
DEFAULT_TRANSITION_VISUAL_SECONDS = 18
DEFAULT_TRANSITION_TAIL_SECONDS = 3.0
DEFAULT_TRANSITION_SEEK_TOLERANCE_SECONDS = 1.25
DEFAULT_TRANSITION_END_GUARD_SECONDS = 0.75
DEFAULT_SMOKE_VIDEO_QUALITY_PREFIX = "480P"


class ApiError(RuntimeError):
    def __init__(self, path: str, status: int, payload: dict[str, Any]) -> None:
        self.path = path
        self.status = status
        self.payload = payload
        message = payload.get("error") or payload.get("message") or f"HTTP {status}"
        super().__init__(f"{path}: {message}")


@dataclass
class ServerHandle:
    base_url: str
    started_here: bool
    server: Any | None = None
    thread: threading.Thread | None = None
    context: Any | None = None

    def stop(self) -> None:
        if not self.started_here or self.server is None:
            return
        print_step("Stopping the server started by this script")
        self.server.shutdown()
        if self.thread is not None:
            self.thread.join(timeout=10)
        if self.context is not None:
            self.context.shutdown()
        self.server.server_close()


@dataclass
class PlayerTimeWindowResult:
    status: str
    current_time: float | None = None


@dataclass
class DownloadResponse:
    body: bytes
    content_type: str
    content_disposition: str


class SmokeRunner:
    def __init__(self, args: argparse.Namespace, handle: ServerHandle) -> None:
        self.args = args
        self.handle = handle
        self.base_url = handle.base_url.rstrip("/")
        self.created_user_names: list[str] = []
        self.created_item_ids: list[str] = []
        self.original_snapshot: dict[str, Any] | None = None

    def run(self) -> None:
        print_header("bilikara developer smoke test")
        print_info(f"Host page: {self.base_url}")
        print_info(f"Remote page: {self.base_url}/remote")
        print_info("This script does not change frontend layout or switch ports.")
        print_info("It drives the current service via API. Use dev/test data when possible.")

        self.wait_for_server_ready()
        self.open_observer_pages()
        self.visual_checkpoint(
            "The host page is open. Keep it visible to inspect player and UI changes during the test."
        )

        self.check_static_pages()
        self.check_remote_surface()
        self.original_snapshot = self.get_state()
        self.print_state_summary(self.original_snapshot, label="Initial state")
        self.print_remote_access(self.original_snapshot)

        if not self.args.skip_bbdown_login:
            self.check_bbdown_login()
        else:
            print_skip("BBDown QR login", "Skipped by --skip-bbdown-login")
        print_skip("Manual cookie input", "Skipped by request")

        self.check_service_settings()
        self.check_users()
        self.check_song_flow()
        self.check_player_controls()
        self.check_history_exports()
        self.check_gatcha()

        if self.args.destructive:
            self.check_destructive_maintenance()
        else:
            print_skip("Clear playlist / history / data", "Pass --destructive to run data-clearing checks")

        self.final_report()

    def wait_for_server_ready(self) -> None:
        deadline = time.time() + 20
        last_error = ""
        while time.time() < deadline:
            try:
                self.get_state(timeout=2)
                print_ok("State API is reachable")
                return
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                time.sleep(0.5)
        raise RuntimeError(f"Server did not become ready: {last_error}")

    def open_observer_pages(self) -> None:
        if self.args.no_open_browser:
            print_skip("Open browser", "Skipped by --no-open-browser")
            return
        opened_host = webbrowser.open(self.base_url)
        time.sleep(0.5)
        opened_remote = webbrowser.open_new_tab(f"{self.base_url}/remote")
        if opened_host:
            print_ok("Requested the system browser to open the host page")
        else:
            print_warn("Browser open was not confirmed for the Host page; open the URL manually if needed.")
        if opened_remote:
            print_ok("Requested the system browser to open the Remote page")
        else:
            print_warn("Browser open was not confirmed for the Remote page; open /remote manually if needed.")

    def visual_checkpoint(self, message: str, seconds: float | None = None) -> None:
        pause_seconds = self.args.visual_pause if seconds is None else seconds
        print_step(f"Visual checkpoint: {message}")
        if pause_seconds <= 0:
            return
        print_info(f"Pausing {pause_seconds:.0f}s for visual inspection.")
        time.sleep(pause_seconds)

    def check_static_pages(self) -> None:
        print_header("Static pages and assets")
        static_bodies: dict[str, bytes] = {}
        for path in ["/", "/remote", "/app.js", "/styles.css", "/remote.js", "/remote.css", "/remote-queue.js"]:
            body = self.http_get(path, expect_json=False)
            static_bodies[path] = body
            print_ok(f"GET {path} ({len(body)} bytes)")
        self.check_recent_feature_static_surface(static_bodies)

    def check_recent_feature_static_surface(self, static_bodies: dict[str, bytes]) -> None:
        print_header("Recent UI surface checks")
        expected_tokens = {
            "/": [
                "search-cookie-toggle",
                "follow-up-grid",
                "follow-song-results",
                "binding-modal-confirm",
                "history-export-button",
                "update-check-button",
                "gatcha-uid-form",
                "refresh-gatcha-cache-button",
                "pull-gatcha-favlist-button",
                "gatcha-favlist-modal",
            ],
            "/remote": [
                "follow-browse-toggle",
                "follow-up-grid",
                "follow-song-results",
                "binding-sheet-actions",
                "history-export-row",
                "gatcha-uid-form",
                "refresh-gatcha-cache-button",
                "pull-gatcha-favlist-button",
                "gatcha-favlist-sheet",
            ],
            "/app.js": [
                "fetchGatchaBrowse",
                "followSongResults",
                "handleAddByUrl",
                "downloadHistoryExport",
                "previewGatchaUid",
                "/api/gatcha/favlist/preview",
                "/api/gatcha/refresh",
                "/api/gatcha/favlist",
                "/api/app/update",
            ],
            "/remote.js": [
                "fetchGatchaBrowse",
                "followSongResults",
                "addByUrl",
                "downloadHistoryExport",
                "previewGatchaUid",
                "/api/gatcha/favlist/preview",
                "/api/gatcha/refresh",
                "/api/gatcha/favlist",
            ],
            "/styles.css": [
                "grid-template-rows: auto auto minmax(0, 1fr) auto",
                ".selection-modal-actions",
                ".follow-up-grid",
                ".gatcha-uid-view .gatcha-uid-form",
            ],
            "/remote.css": [
                "flex-direction: column",
                ".binding-sheet-actions",
                ".follow-up-grid",
                ".gatcha-uid-form",
            ],
        }
        for path, tokens in expected_tokens.items():
            body = static_bodies.get(path)
            if body is None:
                continue
            text = body.decode("utf-8", errors="replace")
            missing = [token for token in tokens if token not in text]
            if missing:
                raise RuntimeError(f"{path} missing recent UI token(s): {missing}")
            elif tokens:
                print_ok(f"{path} includes recent follow/binding UI hooks")

    def check_remote_surface(self) -> None:
        print_header("Remote page surface")
        state = self.get_state(remote=True)
        print_ok(f"Remote state API works: queue={len(state.get('playlist') or [])} users={len(state.get('session_users') or [])}")
        result = self.http_get(f"/api/gatcha/search?q={urllib.parse.quote(GATCHA_MULTI_PAGE_QUERY)}", remote=True)
        items = ((result.get("data") or {}).get("items") or []) if isinstance(result, dict) else []
        print_ok(f"Remote gatcha search API works for multi-page keyword: {len(items)} results")
        self.check_follow_browse_api("Remote follow browse", remote=True)
        self.visual_checkpoint("Remote page should be open in another browser tab. Check queue, search, and control layout there.")

    def check_bbdown_login(self) -> None:
        print_header("BBDown QR login")
        state = self.get_state()
        login = ((state.get("bbdown") or {}).get("login") or {})
        print_info(f"Current BBDown state: {login.get('state')} / logged_in={login.get('logged_in')}")
        print_info(f"BBDown.data: {login.get('data_path')}")

        if login.get("logged_in") and not self.args.force_bbdown_login:
            print_ok("BBDown is already logged in. Use --force-bbdown-login to retest the QR flow.")
            return

        if login.get("logged_in") and self.args.force_bbdown_login:
            print_step("Force login retest: logging out of BBDown first")
            self.api_post("/api/bbdown/logout", {})

        print_step("Starting BBDown login flow")
        self.api_post("/api/bbdown/login/start", {"force": True})
        print_info("Open Service Settings on the host page, or scan the QR image saved by this script.")
        print_info("Waiting for scan completion. Use --bbdown-timeout to adjust; 0 waits forever.")

        deadline = None if self.args.bbdown_timeout <= 0 else time.time() + self.args.bbdown_timeout
        last_signature = ""
        qr_written = False
        while deadline is None or time.time() < deadline:
            state = self.get_state(timeout=5)
            login = ((state.get("bbdown") or {}).get("login") or {})
            signature = json.dumps(
                {
                    "state": login.get("state"),
                    "logged_in": login.get("logged_in"),
                    "message": login.get("message"),
                    "qr": bool(login.get("qr_image")),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            if signature != last_signature:
                print_info(
                    "BBDown login state: "
                    f"state={login.get('state')} logged_in={login.get('logged_in')} "
                    f"message={login.get('message')} qr_image={bool(login.get('qr_image'))}"
                )
                last_signature = signature
            if login.get("qr_image") and not qr_written:
                qr_path = self.write_qr_image(str(login.get("qr_image")))
                if qr_path:
                    print_info(f"QR image saved to: {qr_path}")
                    qr_written = True
            if login.get("logged_in"):
                print_ok("BBDown QR login completed")
                return
            if login.get("state") == "failed":
                print_warn("BBDown login failed. Check the host page or logs/bbdown.")
                return
            time.sleep(2)
        print_warn("Timed out waiting for BBDown QR login; continuing.")

    def write_qr_image(self, data_url: str) -> Path | None:
        prefix = "data:image/png;base64,"
        if not data_url.startswith(prefix):
            return None
        target = Path.cwd() / ".tmp-dev-smoke-bbdown-qrcode.png"
        try:
            target.write_bytes(base64.b64decode(data_url[len(prefix):]))
        except (OSError, ValueError) as exc:
            print_warn(f"Failed to save QR image: {exc}")
            return None
        return target

    def check_service_settings(self) -> None:
        print_header("Service and player settings APIs")
        state = self.get_state()
        original_mode = state.get("playback_mode") or "local"
        original_settings = dict(state.get("player_settings") or {})
        original_policy = dict(state.get("cache_policy") or {})

        next_mode = "online" if original_mode == "local" else "local"
        state = self.api_post("/api/mode", {"mode": next_mode})
        print_ok(f"Playback mode switched to {state.get('playback_mode')}")
        state = self.api_post("/api/mode", {"mode": original_mode})
        print_ok(f"Playback mode restored to {state.get('playback_mode')}")

        update_response = self.http_get("/api/app/update", timeout=15)
        update_payload = update_response.get("data") if isinstance(update_response, dict) else {}
        if not update_response.get("ok") or not isinstance(update_payload, dict):
            raise RuntimeError("Update check API did not return a valid payload")
        for key in ["current_version", "latest_version", "release_url", "update_available"]:
            if key not in update_payload:
                raise RuntimeError(f"Update check API payload missing {key}")
        print_ok(
            "Update check API works: "
            f"current={update_payload.get('current_version')} latest={update_payload.get('latest_version')}"
        )

        state = self.api_post("/api/player/volume", {"volume_percent": 80, "is_muted": False})
        settings = state.get("player_settings") or {}
        print_ok(f"Volume set to {settings.get('volume_percent')}%, muted={settings.get('is_muted')}")

        state = self.api_post("/api/player/av-offset", {"offset_ms": 120})
        print_ok(f"AV offset set to {(state.get('player_settings') or {}).get('av_offset_ms')} ms")

        state = self.api_post("/api/player/advance-delay", {"delay_seconds": 2})
        print_ok(f"Song advance delay set to {(state.get('player_settings') or {}).get('song_advance_delay_seconds')}s")

        choices = original_policy.get("video_quality_choices") or []
        current_quality = original_policy.get("video_quality")
        alternate_quality = ""
        for choice in choices:
            value = str((choice or {}).get("value") or "").strip()
            if value and value != current_quality:
                alternate_quality = value
                break
        if alternate_quality:
            state = self.api_post(
                "/api/cache-policy",
                {
                    "video_quality": alternate_quality,
                    "audio_hires": not bool(original_policy.get("audio_hires")),
                },
            )
            policy = state.get("cache_policy") or {}
            print_ok(
                "Video quality/Hi-Res selection API works: "
                f"quality={policy.get('video_quality')} hires={policy.get('audio_hires')}"
            )
        else:
            print_skip("Video quality selection", "No alternate quality choice was available")

        policy_payload = {}
        if "max_cache_items" in original_policy:
            policy_payload["max_cache_items"] = original_policy["max_cache_items"]
        if "video_quality" in original_policy:
            policy_payload["video_quality"] = original_policy["video_quality"]
        if "audio_hires" in original_policy:
            policy_payload["audio_hires"] = original_policy["audio_hires"]
        if policy_payload:
            state = self.api_post("/api/cache-policy", policy_payload)
            policy = state.get("cache_policy") or {}
            print_ok(
                "Cache policy restored: "
                f"max={policy.get('max_cache_items')} quality={policy.get('video_quality')} hires={policy.get('audio_hires')}"
            )
        else:
            print_skip("Cache policy API", "Current state has no cache_policy")

        restore_payload: dict[str, Any] = {}
        if "volume_percent" in original_settings:
            restore_payload["volume_percent"] = int(original_settings.get("volume_percent") or 100)
        if "is_muted" in original_settings:
            restore_payload["is_muted"] = bool(original_settings.get("is_muted"))
        if restore_payload:
            self.api_post("/api/player/volume", restore_payload)
        if "av_offset_ms" in original_settings:
            self.api_post("/api/player/av-offset", {"offset_ms": int(original_settings.get("av_offset_ms") or 0)})
        if "song_advance_delay_seconds" in original_settings:
            self.api_post(
                "/api/player/advance-delay",
                {"delay_seconds": int(original_settings.get("song_advance_delay_seconds") or 0)},
            )
        print_ok("Player settings restored to the pre-test values")
        self.visual_checkpoint("Service Settings should keep its layout; values may have changed briefly and then restored.")

    def smoke_download_quality(self, cache_policy: dict[str, Any]) -> str:
        choices = cache_policy.get("video_quality_choices") or []
        for choice in choices:
            value = str((choice or {}).get("value") or "").strip()
            if value.startswith(DEFAULT_SMOKE_VIDEO_QUALITY_PREFIX):
                return value
        return ""

    def set_smoke_download_quality(self) -> dict[str, Any]:
        state = self.get_state()
        original_policy = dict(state.get("cache_policy") or {})
        target_quality = self.smoke_download_quality(original_policy)
        if not target_quality:
            print_skip("Smoke download quality", "No 480P video quality choice was available")
            return {}

        policy_payload: dict[str, Any] = {"video_quality": target_quality, "audio_hires": False}
        state = self.api_post("/api/cache-policy", policy_payload)
        policy = state.get("cache_policy") or {}
        print_ok(
            "Smoke download policy set before song downloads: "
            f"quality={policy.get('video_quality')} hires={policy.get('audio_hires')}"
        )

        restore_payload: dict[str, Any] = {}
        if "video_quality" in original_policy:
            restore_payload["video_quality"] = original_policy["video_quality"]
        if "audio_hires" in original_policy:
            restore_payload["audio_hires"] = bool(original_policy.get("audio_hires"))
        return restore_payload

    def restore_smoke_download_quality(self, policy_payload: dict[str, Any]) -> None:
        if not policy_payload:
            return
        state = self.api_post("/api/cache-policy", policy_payload)
        policy = state.get("cache_policy") or {}
        print_ok(
            "Restored download quality policy: "
            f"quality={policy.get('video_quality')} hires={policy.get('audio_hires')}"
        )

    def check_users(self) -> None:
        print_header("Local user management")
        suffix = str(int(time.time()))[-6:]
        primary = f"Smoke{suffix}"
        helper = f"SmokeB{suffix}"
        self.add_user(primary)
        self.add_user(helper)
        self.created_user_names.extend([primary, helper])
        state = self.api_post("/api/session-users/reorder", {"name": helper, "index": 0})
        print_ok(f"User reorder API works: {state.get('session_users')}")
        self.api_post("/api/session-users/remove", {"name": helper})
        print_ok(f"Removed temporary user: {helper}")
        self.created_user_names.remove(helper)

    def add_user(self, name: str) -> None:
        try:
            state = self.api_post("/api/session-users/add", {"name": name})
            print_ok(f"Added user: {name} -> {state.get('session_users')}")
        except ApiError as exc:
            if "already" in str(exc).lower() or "exists" in str(exc).lower() or "duplicate" in str(exc).lower():
                print_warn(f"User already exists; continuing: {name}")
                return
            raise

    def check_song_flow(self) -> None:
        print_header("Song request, queue, search, multi-page binding, and cache buffering")
        song_urls = list(self.args.song_url or [])
        if song_urls:
            print_info(f"Using song URLs from command line: {len(song_urls)}")
        else:
            song_urls = self.pick_gatcha_song_urls(8)
        if not song_urls and not self.args.non_interactive:
            raw = input("Gatcha did not return a usable URL. Enter a Bilibili URL for song testing, or leave blank to skip: ").strip()
            if raw:
                song_urls.append(raw)
        if not song_urls:
            print_skip("Song request / cache / player visuals", "No --song-url was provided and gatcha returned no usable URL")
            return

        state = self.get_state()
        requester = self.created_user_names[0] if self.created_user_names else None
        if not requester:
            users = state.get("session_users") or []
            requester = users[0] if users else "Smoke"
            if not users:
                self.add_user(requester)
                self.created_user_names.append(requester)

        restore_smoke_policy = self.set_smoke_download_quality()
        try:
            self.check_song_download_flow(song_urls, requester)
        finally:
            self.restore_smoke_download_quality(restore_smoke_policy)

    def check_song_download_flow(self, song_urls: list[str], requester: str) -> None:
        added_items: list[dict[str, Any]] = []
        multi_item = self.check_search_multi_page_binding(requester)
        if multi_item:
            added_items.append(multi_item)
            self.created_item_ids.append(str(multi_item.get("id") or ""))
            print_ok(f"Multi-page search item added: {multi_item.get('display_title')} ({multi_item.get('id')})")

        regular_count = 2 if multi_item else 3
        regular_urls = list(song_urls) if len(song_urls) >= regular_count else self.urls_for_count(song_urls, regular_count)
        top_song_added = False
        regular_added_count = 0
        for url in regular_urls:
            if regular_added_count >= regular_count:
                break
            has_current = bool((self.get_state().get("current_item") or {}).get("id"))
            position = "next" if has_current and not top_song_added else "tail"
            before_ids = self.item_ids(self.get_state())
            try:
                state = self.add_song(url, requester, position=position)
            except ApiError as exc:
                print_warn(f"Skipping unusable song candidate: {url}: {exc}")
                continue
            if position == "next":
                top_song_added = True
            item = self.find_item_not_in_ids(state, before_ids) or self.find_newest_item(state, prefer_playlist=True)
            if not item:
                continue
            added_items.append(item)
            self.created_item_ids.append(str(item.get("id") or ""))
            regular_added_count += 1
            if position == "next":
                print_ok(f"Top-song request succeeded: {item.get('display_title')} ({item.get('id')})")
            elif regular_added_count == 1 and not multi_item:
                print_ok(f"Current song request succeeded: {item.get('display_title')} ({item.get('id')})")
            else:
                print_ok(f"Queued song #{regular_added_count}: {item.get('display_title')} ({item.get('id')})")

        if regular_added_count < regular_count:
            print_warn(f"Only added {regular_added_count}/{regular_count} regular song candidates; continuing with available items")

        self.exercise_playlist_resort(song_urls)
        restore_cache_max = self.expand_cache_window_for_items(len(added_items))
        try:
            self.focus_created_items_for_cache_window(added_items)
            current_item_id = str(((self.get_state().get("current_item") or {}).get("id")) or "")
            if current_item_id:
                self.exercise_current_item_recache(current_item_id)
            self.visual_checkpoint("Host and Remote pages should now show this test's current song plus queued songs. Inspect both before caching completes.", seconds=5)

            created_ids = [str((item or {}).get("id") or "") for item in added_items if str((item or {}).get("id") or "")]
            state = self.get_state()
            queued = state.get("playlist") or []
            target_id = ""
            for item_id in reversed(created_ids[1:]):
                if any(str(item.get("id") or "") == item_id for item in queued):
                    target_id = item_id
                    break
            if target_id:
                self.api_post("/api/playlist/move-next", {"item_id": target_id})
                state = self.get_state()
                first_id = str(((state.get("playlist") or [{}])[0]).get("id") or "")
                if first_id == target_id:
                    print_ok(f"Move-to-next/top-song API placed created item at the front: {target_id}")
                else:
                    print_warn(f"Move-to-next API returned, but front item is {first_id}; expected {target_id}")
                self.api_post("/api/playlist/reorder", {"item_id": target_id, "index": 0})
                print_ok(f"Playlist reorder API works: {target_id} -> index 0")
                self.exercise_cache_retry(target_id)
            elif queued:
                item_id = str(queued[0].get("id") or "")
                self.api_post("/api/playlist/move-next", {"item_id": item_id})
                print_ok(f"Move-to-next API was exercised with the only queued item: {item_id}")
            else:
                print_skip("Move-to-next/top-song API", "No queued song was available")

            self.wait_for_created_item_caches(self.cache_window_created_items(added_items))
            if multi_item:
                self.check_audio_variant_switch(str(multi_item.get("id") or ""))
            self.visual_checkpoint("Downloads have been waited on. Inspect the player media, queue badges, and Remote queue state.", seconds=8)
        finally:
            if restore_cache_max is not None:
                self.api_post("/api/cache-policy", {"max_cache_items": restore_cache_max})
                print_ok(f"Restored max cache items to {restore_cache_max}")

    def focus_created_items_for_cache_window(self, added_items: list[dict[str, Any]]) -> None:
        created_ids = [str((item or {}).get("id") or "") for item in added_items if str((item or {}).get("id") or "")]
        if not created_ids:
            return
        state = self.get_state()
        current_id = str((state.get("current_item") or {}).get("id") or "")
        first_id = created_ids[0]
        if current_id != first_id:
            try:
                self.api_post("/api/playlist/play-now", {"item_id": first_id})
                print_ok(f"Focused first created item as current song: {first_id}")
            except ApiError as exc:
                print_warn(f"Could not focus first created item {first_id}: {exc}")
        for item_id in reversed(created_ids[1:]):
            try:
                self.api_post("/api/playlist/move-next", {"item_id": item_id})
                print_ok(f"Focused created queued item near the front: {item_id}")
            except ApiError as exc:
                print_warn(f"Could not move created item near the front {item_id}: {exc}")

    def expand_cache_window_for_items(self, item_count: int) -> int | None:
        if item_count <= 0:
            return None
        state = self.get_state()
        policy = state.get("cache_policy") or {}
        try:
            current_max = int(policy.get("max_cache_items") or 0)
        except (TypeError, ValueError):
            return None
        if current_max >= item_count:
            return None
        state = self.api_post("/api/cache-policy", {"max_cache_items": item_count})
        policy = state.get("cache_policy") or {}
        print_ok(f"Expanded max cache items for this smoke run: {policy.get('max_cache_items')}")
        return current_max

    def cache_window_created_items(self, added_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        state = self.get_state()
        policy = state.get("cache_policy") or {}
        try:
            max_items = max(1, int(policy.get("max_cache_items") or 3))
        except (TypeError, ValueError):
            max_items = 3
        active_ids: list[str] = []
        current = state.get("current_item") or {}
        if current.get("id"):
            active_ids.append(str(current.get("id")))
        for item in state.get("playlist") or []:
            if len(active_ids) >= max_items:
                break
            item_id = str(item.get("id") or "")
            if item_id:
                active_ids.append(item_id)
        filtered = [item for item in added_items if str((item or {}).get("id") or "") in active_ids]
        skipped = [str((item or {}).get("id") or "") for item in added_items if str((item or {}).get("id") or "") and str((item or {}).get("id") or "") not in active_ids]
        if skipped:
            print_warn(f"Skipping cache wait for created items outside the active cache window: {skipped}")
        return filtered

    def pick_gatcha_song_urls(self, count: int) -> list[str]:
        print_step(f"No --song-url was provided; picking {count} random videos from gatcha candidates")
        urls: list[str] = []
        seen: set[str] = set()
        attempts = max(6, count * 4)
        for attempt in range(1, attempts + 1):
            try:
                result = self.http_get("/api/gatcha/candidate", timeout=30)
            except Exception as exc:  # noqa: BLE001
                print_warn(f"Failed to get gatcha candidate: {exc}")
                break
            if not result.get("ok"):
                print_warn(f"Gatcha candidate returned no song: {result.get('error')}")
                break
            candidate = result.get("data") or {}
            url = str(candidate.get("url") or "").strip()
            title = str(candidate.get("title") or candidate.get("bvid") or url).strip()
            if not url:
                print_warn(f"Gatcha candidate #{attempt} had no URL; skipping")
                continue
            if url in seen:
                print_info(f"Duplicate gatcha candidate; drawing again: {title}")
                continue
            seen.add(url)
            urls.append(url)
            print_ok(f"Gatcha selected: {title} -> {url}")
            if len(urls) >= count:
                break
        if len(urls) < count:
            print_warn(f"Gatcha only returned {len(urls)}/{count} usable videos")
        return urls

    def urls_for_count(self, urls: list[str], count: int) -> list[str]:
        if not urls or count <= 0:
            return []
        return [urls[index % len(urls)] for index in range(count)]

    def check_search_multi_page_binding(self, requester: str) -> dict[str, Any] | None:
        print_header("Gatcha search and multi-page binding")
        query = urllib.parse.quote(GATCHA_MULTI_PAGE_QUERY)
        try:
            result = self.http_get(f"/api/gatcha/search?q={query}", timeout=30)
        except Exception as exc:  # noqa: BLE001
            print_warn(f"Search for multi-page keyword failed: {exc}")
            return None
        items = ((result.get("data") or {}).get("items") or []) if isinstance(result, dict) else []
        print_ok(f"Search keyword returned {len(items)} candidates")
        if not items:
            return None
        for entry in items[:8]:
            url = str((entry or {}).get("url") or "").strip()
            title = str((entry or {}).get("title") or (entry or {}).get("bvid") or url).strip()
            if not url:
                continue
            item = self.try_add_multi_page_search_result(url, title, requester)
            if item:
                return item
        print_warn("No searched result triggered multi-page binding in the first candidates")
        return None

    def try_add_multi_page_search_result(self, url: str, title: str, requester: str) -> dict[str, Any] | None:
        payload: dict[str, Any] = {
            "url": url,
            "position": "tail",
            "requester_name": requester,
            "allow_repeat": True,
        }
        try:
            state = self.api_post("/api/playlist/add", payload, timeout=60)
        except ApiError as exc:
            if exc.payload.get("code") != "manual_binding_required":
                print_warn(f"Search result could not be probed: {title}: {exc}")
                return None
            binding = exc.payload.get("binding") or {}
            pages = binding.get("pages") or []
            if len(pages) <= 1:
                print_warn(f"Manual binding returned only one page for {title}; skipping")
                return None
            page_numbers = [int(page.get("page") or 0) for page in pages if int(page.get("page") or 0) > 0]
            selected_page = 2 if 2 in page_numbers else page_numbers[min(1, len(page_numbers) - 1)]
            audio_pages = [page for page in page_numbers[:2] if page > 0]
            if selected_page not in audio_pages:
                audio_pages.append(selected_page)
            print_ok(
                f"Multi-page binding required for search result; selecting video P{selected_page} "
                f"with audio pages {audio_pages}: {title}"
            )
            payload["selected_video_page"] = selected_page
            payload["selected_audio_pages"] = audio_pages
            state = self.api_post("/api/playlist/add", payload, timeout=60)
            item = self.find_newest_item(state, prefer_playlist=True)
            if item:
                print_ok(
                    f"Multi-page add confirmed: page={item.get('page')} "
                    f"selected_pages={item.get('selected_pages')} available_pages={item.get('available_pages')}"
                )
            return item

        item = self.find_newest_item(state, prefer_playlist=True)
        if item:
            item_id = str(item.get("id") or "")
            print_info(f"Search result did not require multi-page binding; removing probe item: {title} ({item_id})")
            if item_id:
                self.api_post("/api/playlist/remove", {"item_id": item_id})
        return None

    def add_song(self, url: str, requester: str, *, position: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "url": url,
            "position": position,
            "requester_name": requester,
            "allow_repeat": True,
        }
        try:
            return self.api_post("/api/playlist/add", payload, timeout=60)
        except ApiError as exc:
            if exc.payload.get("code") != "manual_binding_required":
                raise
            binding = exc.payload.get("binding") or {}
            pages = binding.get("pages") or []
            selected_page = binding.get("preferred_page") or (pages[0].get("page") if pages else None)
            if not selected_page:
                raise
            print_warn(f"Video requires manual page binding; selecting P{selected_page}: {binding.get('title')}")
            payload["selected_video_page"] = int(selected_page)
            payload["selected_audio_pages"] = [int(selected_page)]
            return self.api_post("/api/playlist/add", payload, timeout=60)

    def wait_for_created_item_caches(self, items: list[dict[str, Any]]) -> None:
        unique_ids: list[str] = []
        for item in items:
            item_id = str((item or {}).get("id") or "")
            if item_id and item_id not in unique_ids:
                unique_ids.append(item_id)
        if not unique_ids:
            print_skip("Cache completion wait", "No created items to wait for")
            return
        print_header("Cache completion wait")
        for item_id in unique_ids:
            self.wait_for_cache(item_id)

    def exercise_playlist_resort(self, song_urls: list[str]) -> None:
        if not song_urls:
            print_skip("Playlist resort API", "No song URLs were available for resort testing")
            return
        state = self.get_state()
        current = state.get("current_item") or {}
        current_requester = str(current.get("requester_name") or "").strip()
        if not current_requester:
            print_skip("Playlist resort API", "Need a current song with a requester before testing resort")
            return

        print_header("Playlist resort API")
        suffix = str(int(time.time()))[-6:]
        temp_users = [f"Cycle{suffix}A", f"Cycle{suffix}B"]
        temp_items: list[dict[str, Any]] = []
        added_users: list[str] = []
        urls = self.urls_for_count(song_urls, max(len(temp_users), min(len(song_urls), len(temp_users) * 4)))

        try:
            for user_name in temp_users:
                self.add_user(user_name)
                added_users.append(user_name)

            for url in urls:
                if len(temp_items) >= len(temp_users):
                    break
                user_name = temp_users[len(temp_items)]
                before_ids = self.item_ids(self.get_state())
                try:
                    state = self.add_song(url, user_name, position="tail")
                except ApiError as exc:
                    print_warn(f"Skipping unusable resort probe candidate for {user_name}: {url}: {exc}")
                    continue
                item = self.find_item_not_in_ids(state, before_ids) or self.find_newest_item(state, prefer_playlist=True)
                if not item:
                    continue
                temp_items.append(item)
                print_ok(f"Resort probe item added: {item.get('display_title')} ({item.get('id')}) requester={user_name}")

            if len(temp_items) < 2:
                print_skip("Playlist resort API", "Could not create enough probe queue items")
                return

            state = self.get_state()
            playlist = state.get("playlist") or []
            first_id = str(temp_items[0].get("id") or "")
            second_id = str(temp_items[1].get("id") or "")
            first_index = next((index for index, item in enumerate(playlist) if str(item.get("id") or "") == first_id), None)
            second_index = next((index for index, item in enumerate(playlist) if str(item.get("id") or "") == second_id), None)
            if first_index is None or second_index is None:
                print_skip("Playlist resort API", "Probe items were not found in the queue")
                return
            if first_index < second_index:
                self.api_post("/api/playlist/reorder", {"item_id": second_id, "index": first_index})
                print_ok(f"Scrambled queue order for resort test: {second_id} moved before {first_id}")
            else:
                print_ok("Probe queue order was already scrambled for resort testing")

            state = self.api_post("/api/playlist/resort", {}, remote=True)
            playlist = state.get("playlist") or []
            expected_users = self.rotated_users_after_current(state, current_requester, temp_users)
            actual_users = [
                str(item.get("requester_name") or "").strip()
                for item in playlist
                if str(item.get("id") or "") in {first_id, second_id}
            ]
            if actual_users == expected_users:
                print_ok(f"Playlist resort API works: requester order {actual_users}")
            else:
                print_warn(f"Playlist resort returned requester order {actual_users}; expected {expected_users}")
        finally:
            for item in temp_items:
                item_id = str(item.get("id") or "")
                if not item_id:
                    continue
                try:
                    self.api_post("/api/playlist/remove", {"item_id": item_id})
                except ApiError as exc:
                    print_warn(f"Could not remove resort probe item {item_id}: {exc}")
            for user_name in added_users:
                try:
                    self.api_post("/api/session-users/remove", {"name": user_name})
                except ApiError as exc:
                    print_warn(f"Could not remove resort probe user {user_name}: {exc}")

    def exercise_current_item_recache(self, item_id: str) -> None:
        print_header("Current song re-cache")
        deadline = time.time() + 20
        last_status = ""
        while time.time() < deadline:
            state = self.get_state(timeout=10)
            current = state.get("current_item") or {}
            current_id = str(current.get("id") or "")
            if current_id != item_id:
                print_skip("Current song re-cache", f"Current song changed before retry test: {item_id} -> {current_id or 'none'}")
                return
            cache_status = str(current.get("cache_status") or "").strip() or "unknown"
            if cache_status != last_status:
                print_info(f"Current item cache status before re-cache: {cache_status}")
                last_status = cache_status
            if cache_status in {"downloading", "failed"}:
                self.api_post("/api/cache/retry", {"item_id": item_id, "force": True})
                print_ok(f"Current song re-cache API works: {item_id} (from {cache_status}, force=true)")
                return
            if cache_status == "ready":
                print_skip("Current song re-cache", f"Current song became ready before a retryable state was observed: {item_id}")
                return
            time.sleep(1)
        print_skip("Current song re-cache", "Current song did not reach a retryable cache state in time")

    def exercise_cache_retry(self, item_id: str) -> None:
        state = self.get_state()
        item = self.find_item_by_id(state, item_id)
        if not item:
            print_skip("Cache retry API", f"Target item not found: {item_id}")
            return
        cache_status = str(item.get("cache_status") or "").strip() or "unknown"
        if cache_status not in {"downloading", "failed"}:
            print_skip(
                "Cache retry API",
                f"Skipped because current cache status is not retryable: {cache_status} ({item_id})",
            )
            return
        self.api_post("/api/cache/retry", {"item_id": item_id})
        print_ok(f"Cache retry API works: {item_id} (from {cache_status})")

    def wait_for_cache(self, item_id: str) -> bool:
        print_step(f"Waiting for local cache/buffer: {item_id}")
        deadline = time.time() + self.args.cache_timeout
        last_signature = ""
        while time.time() < deadline:
            state = self.get_state(timeout=10)
            item = self.find_item_by_id(state, item_id)
            if not item:
                print_warn(f"Item not found: {item_id}")
                return False
            signature = json.dumps(
                {
                    "status": item.get("cache_status"),
                    "progress": item.get("cache_progress"),
                    "message": item.get("cache_message"),
                    "bytes": item.get("cache_size_bytes"),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            if signature != last_signature:
                print_info(
                    "Cache state: "
                    f"status={item.get('cache_status')} progress={item.get('cache_progress')} "
                    f"bytes={item.get('cache_size_bytes')} message={item.get('cache_message')}"
                )
                last_signature = signature
            if item.get("cache_status") == "ready":
                print_ok("Cache is ready; the player should use local media resources")
                return True
            if item.get("cache_status") == "failed":
                print_warn("Cache failed; continuing with API checks. Check host page and logs/bbdown.")
                return False
            time.sleep(self.args.cache_poll_interval)
        print_warn("Timed out waiting for cache; continuing.")
        return False

    def check_audio_variant_switch(self, item_id: str) -> None:
        state = self.get_state()
        current = state.get("current_item") or {}
        if str(current.get("id") or "") != item_id:
            print_skip("Audio/part switch", "The multi-page item is no longer current")
            return
        variants = [variant for variant in current.get("audio_variants") or [] if variant.get("id")]
        if len(variants) <= 1:
            print_skip("Audio/part switch", "The current multi-page item has one or zero cached variants")
            return
        selected = str(current.get("selected_audio_variant_id") or "")
        target = next((variant for variant in variants if str(variant.get("id") or "") != selected), variants[0])
        target_id = str(target.get("id") or "")
        state = self.api_post("/api/player/audio-variant", {"item_id": item_id, "variant_id": target_id})
        current = state.get("current_item") or {}
        if str(current.get("selected_audio_variant_id") or "") == target_id:
            print_ok(f"Audio/part switch API works: selected variant {target_id}")
        else:
            print_warn(f"Audio/part switch did not select expected variant {target_id}")
        self.visual_checkpoint("Inspect the audio/part selector on Host and Remote; the selected variant should have changed.", seconds=5)

    def check_player_controls(self) -> None:
        print_header("Player controls, Remote controls, transition view, and reset")
        state = self.get_state()
        current = state.get("current_item") or {}
        current_id = str(current.get("id") or "")
        if current_id:
            self.api_post("/api/player/status", {"item_id": current_id, "is_paused": True, "current_time": 0.0})
            print_ok("Player status report API works")
            state = self.api_post("/api/player/control", {"action": "toggle-play", "item_id": current_id})
            command = state.get("player_control_command") or {}
            print_ok(f"Host play/pause control command: seq={command.get('seq')} action={command.get('action')}")
            state = self.api_post(
                "/api/player/control",
                {"action": "seek-relative", "item_id": current_id, "delta_seconds": 10},
            )
            command = state.get("player_control_command") or {}
            print_ok(f"Host seek control command: seq={command.get('seq')} delta={command.get('delta_seconds')}")
            state = self.api_post(
                "/api/player/control",
                {"action": "seek-relative", "item_id": current_id, "delta_seconds": -5},
                remote=True,
            )
            command = state.get("player_control_command") or {}
            print_ok(f"Remote seek control command: seq={command.get('seq')} delta={command.get('delta_seconds')}")
        else:
            print_skip("Player controls", "No current song")

        state = self.get_state()
        if state.get("playlist") and current_id:
            original_delay = int((state.get("player_settings") or {}).get("song_advance_delay_seconds") or 0)
            self.api_post("/api/player/advance-delay", {"delay_seconds": 5})
            try:
                if self.seek_current_item_near_end(current_id, tail_seconds=DEFAULT_TRANSITION_TAIL_SECONDS):
                    print_ok("Requested Remote seek to 3s before the end of the current song for transition UI testing")
                else:
                    print_warn("Could not confirm a near-end seek; transition UI may require fallback next-song")
                self.visual_checkpoint(
                    "Watch the Host player now. Playback should be about 3s before the end so the in-player countdown can stay visible without leaving fullscreen.",
                    seconds=self.args.transition_visual_pause,
                )
                state_after_seek = self.get_state()
                current_after_seek = (state_after_seek.get("current_item") or {}).get("id")
                if current_after_seek == current_id and state_after_seek.get("playlist"):
                    self.api_post("/api/player/next", {})
                    print_ok("Forced next-song API after transition visual window")
                else:
                    print_ok("Current song changed during transition visual window")
            finally:
                self.api_post("/api/player/advance-delay", {"delay_seconds": original_delay})
            new_current = self.get_state().get("current_item") or {}
            new_current_id = str(new_current.get("id") or "")
            if new_current_id:
                self.wait_for_cache(new_current_id)
            self.visual_checkpoint("Inspect the player after the transition. The next song should be loaded and the queue should update.", seconds=8)
        else:
            print_skip("Transition UI and next-song API", "Need a current song and at least one queued song")

        state = self.api_post("/api/player/reset", {})
        settings = state.get("player_settings") or {}
        print_ok(
            "Player reset API works: "
            f"mode={state.get('playback_mode')} volume={settings.get('volume_percent')} "
            f"muted={settings.get('is_muted')} offset={settings.get('av_offset_ms')}"
        )
        self.visual_checkpoint("Confirm the player reloaded while queue/history stayed intact.", seconds=8)

    def check_history_exports(self) -> None:
        print_header("History export downloads")
        csv_cases = [
            ("played", False),
            ("history", True),
        ]
        for source, remote in csv_cases:
            response = self.http_download_get(
                f"/api/history/export?format=csv&source={source}",
                timeout=20,
                remote=remote,
            )
            self.assert_download_filename(response, expected_fragment=f"bilikara-{source}", expected_suffix=".csv")
            if not response.content_type.lower().startswith("text/csv"):
                raise RuntimeError(f"CSV export returned unexpected content type: {response.content_type}")
            if not response.body.startswith(b"\xef\xbb\xbf"):
                raise RuntimeError(f"CSV export for {source} did not include a UTF-8 BOM")
            response.body.decode("utf-8-sig")
            client_label = "Remote" if remote else "Host"
            print_ok(f"{client_label} {source} CSV export downloads ({len(response.body)} bytes)")

        image_response = self.http_download_get(
            "/api/history/export?format=image&source=played",
            timeout=30,
        )
        image_type = image_response.content_type.lower()
        if image_type == "image/png":
            self.assert_download_filename(image_response, expected_fragment="bilikara-played", expected_suffix=".png")
            if not image_response.body.startswith(b"\x89PNG\r\n\x1a\n"):
                raise RuntimeError("Played image export did not return PNG bytes")
            print_ok(f"Played image export downloads as PNG ({len(image_response.body)} bytes)")
        elif image_type == "application/zip":
            self.assert_download_filename(image_response, expected_fragment="bilikara-played", expected_suffix=".zip")
            if not image_response.body.startswith(b"PK"):
                raise RuntimeError("Played image export did not return ZIP bytes")
            print_ok(f"Played image export downloads as ZIP ({len(image_response.body)} bytes)")
        else:
            raise RuntimeError(f"Image export returned unexpected content type: {image_response.content_type}")

    def seek_current_item_near_end(self, item_id: str, *, tail_seconds: float) -> bool:
        state = self.get_state()
        item = self.find_item_by_id(state, item_id)
        if not item:
            print_skip("Transition seek", f"Current item was not found: {item_id}")
            return False
        metadata_duration_seconds = self.item_duration_seconds(item)
        observed_duration_seconds = self.wait_for_player_duration_seconds(item_id, timeout=6.0)
        duration_seconds = observed_duration_seconds or metadata_duration_seconds
        if duration_seconds <= 0:
            print_skip("Transition seek", f"Current item duration is unavailable: {item_id}")
            return False
        duration_source = "player media" if observed_duration_seconds else "item metadata"
        current_time = self.player_current_time_seconds(self.get_state(), item_id)
        tolerance_seconds = DEFAULT_TRANSITION_SEEK_TOLERANCE_SECONDS
        end_guard_seconds = DEFAULT_TRANSITION_END_GUARD_SECONDS
        target_time = max(0.0, duration_seconds - max(0.5, tail_seconds))
        remaining = target_time - current_time
        if remaining <= 0.5:
            if current_time >= max(0.0, duration_seconds - end_guard_seconds):
                print_warn(
                    f"Playback is already at the media end: "
                    f"current={current_time:.1f}s duration={duration_seconds:.1f}s"
                )
                return False
            if current_time > target_time + tolerance_seconds:
                print_warn(
                    f"Playback is already past the transition target: "
                    f"current={current_time:.1f}s target={target_time:.1f}s duration={duration_seconds:.1f}s"
                )
                return False
            print_ok(
                f"Playback is already near the transition target: "
                f"current={current_time:.1f}s target={target_time:.1f}s duration={duration_seconds:.1f}s"
            )
            return True
        print_info(
            f"Seeking to {tail_seconds:.1f}s before the end for transition test: current={current_time:.1f}s "
            f"target={target_time:.1f}s duration={duration_seconds:.1f}s source={duration_source}"
        )

        seek_state = self.api_post(
            "/api/player/control",
            {"action": "seek-absolute", "item_id": item_id, "target_seconds": target_time},
            remote=True,
        )
        command = seek_state.get("player_control_command") or {}
        seq = int(command.get("seq") or 0)
        if seq and not self.wait_for_player_control_ack(seq):
            print_warn(f"Timed out waiting for absolute seek command ack: seq={seq} target={target_time:.1f}s")
            return False

        window_result = self.wait_for_player_time_in_transition_window(
            item_id,
            target_seconds=target_time,
            duration_seconds=duration_seconds,
            tolerance_seconds=tolerance_seconds,
            end_guard_seconds=end_guard_seconds,
            timeout=8.0,
        )
        if window_result.status == "ok" and window_result.current_time is not None:
            print_ok(
                f"Player reported near-end playback: "
                f"current={window_result.current_time:.1f}s target={target_time:.1f}s duration={duration_seconds:.1f}s"
            )
            return True

        observed_text = (
            f"{window_result.current_time:.1f}s"
            if window_result.current_time is not None
            else "unavailable"
        )
        print_warn(
            f"Player did not land in the transition window after seek: "
            f"status={window_result.status} current={observed_text} "
            f"target={target_time:.1f}s duration={duration_seconds:.1f}s"
        )
        return False

    def wait_for_player_duration_seconds(self, item_id: str, *, timeout: float) -> float | None:
        deadline = time.time() + timeout
        last_seen: float | None = None
        while time.time() < deadline:
            state = self.get_state(timeout=10)
            duration = self.player_duration_seconds(state, item_id)
            if duration > 0:
                return duration
            status = self.player_status_for_item(state, item_id)
            if status is not None:
                last_seen = duration
            time.sleep(0.5)
        return last_seen if last_seen and last_seen > 0 else None

    def wait_for_player_control_ack(self, seq: int, *, timeout: float = 8.0) -> bool:
        if seq <= 0:
            return True
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = self.get_state(timeout=10)
            command = state.get("player_control_command") or {}
            if not command:
                return True
            if int(command.get("seq") or 0) != seq:
                return True
            time.sleep(0.2)
        return False

    def wait_for_player_time_in_transition_window(
        self,
        item_id: str,
        *,
        target_seconds: float,
        duration_seconds: float,
        tolerance_seconds: float,
        end_guard_seconds: float,
        timeout: float,
    ) -> PlayerTimeWindowResult:
        deadline = time.time() + timeout
        last_seen: float | None = None
        min_seconds = max(0.0, target_seconds - tolerance_seconds)
        max_seconds = min(
            max(0.0, duration_seconds - end_guard_seconds),
            target_seconds + tolerance_seconds,
        )
        if max_seconds < min_seconds:
            max_seconds = min_seconds
        while time.time() < deadline:
            state = self.get_state(timeout=10)
            current_id = str((state.get("current_item") or {}).get("id") or "")
            if current_id != item_id:
                return PlayerTimeWindowResult("item-changed", last_seen)
            status = self.player_status_for_item(state, item_id)
            if status is None:
                time.sleep(0.25)
                continue
            try:
                last_seen = max(0.0, float(status.get("current_time") or 0.0))
            except (TypeError, ValueError):
                time.sleep(0.25)
                continue
            if last_seen >= max(0.0, duration_seconds - end_guard_seconds):
                return PlayerTimeWindowResult("ended", last_seen)
            if min_seconds <= last_seen <= max_seconds:
                return PlayerTimeWindowResult("ok", last_seen)
            if last_seen > max_seconds:
                return PlayerTimeWindowResult("overshot", last_seen)
            time.sleep(0.25)
        return PlayerTimeWindowResult("timeout", last_seen)

    @staticmethod
    def player_status_for_item(state: dict[str, Any], item_id: str) -> dict[str, Any] | None:
        status = state.get("player_status") or {}
        if not isinstance(status, dict):
            return None
        if str(status.get("item_id") or "") != str(item_id or ""):
            return None
        return status

    @classmethod
    def player_current_time_seconds(cls, state: dict[str, Any], item_id: str) -> float:
        status = cls.player_status_for_item(state, item_id)
        if status is None:
            return 0.0
        try:
            return max(0.0, float(status.get("current_time") or 0.0))
        except (TypeError, ValueError):
            return 0.0

    @classmethod
    def player_duration_seconds(cls, state: dict[str, Any], item_id: str) -> float:
        status = cls.player_status_for_item(state, item_id)
        if status is None:
            return 0.0
        try:
            return max(0.0, float(status.get("duration") or 0.0))
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def item_duration_seconds(item: dict[str, Any]) -> float:
        def positive_durations(payload: object) -> list[float]:
            if not isinstance(payload, list):
                return []
            values: list[float] = []
            for value in payload:
                try:
                    duration = float(value or 0)
                except (TypeError, ValueError):
                    continue
                if duration > 0:
                    values.append(duration)
            return values

        page = 0
        try:
            page = int(item.get("page") or item.get("video_page") or 0)
        except (TypeError, ValueError):
            page = 0

        for pages_key, durations_key in (
            ("available_pages", "available_durations"),
            ("selected_pages", "selected_durations"),
        ):
            pages = item.get(pages_key)
            durations = item.get(durations_key)
            if not isinstance(pages, list) or not isinstance(durations, list):
                continue
            for index, page_value in enumerate(pages):
                try:
                    page_number = int(page_value or 0)
                except (TypeError, ValueError):
                    continue
                if page_number != page or index >= len(durations):
                    continue
                try:
                    duration = float(durations[index] or 0)
                except (TypeError, ValueError):
                    continue
                if duration > 0:
                    return duration

        for durations_key in ("selected_durations", "available_durations"):
            durations = positive_durations(item.get(durations_key))
            if durations:
                return max(durations)
        return 0.0

    def check_gatcha(self) -> None:
        print_header("Gatcha")
        self.check_gatcha_uid_management_api()
        try:
            result = self.http_get(f"/api/gatcha/search?q={urllib.parse.quote(GATCHA_MULTI_PAGE_QUERY)}")
            items = ((result.get("data") or {}).get("items") or []) if isinstance(result, dict) else []
            print_ok(f"Gatcha search API works for multi-page keyword: {len(items)} results")
        except ApiError as exc:
            print_warn(f"Gatcha search returned an error: {exc}")

        self.check_follow_browse_api("Host follow browse", remote=False)

        try:
            result = self.http_get("/api/gatcha/candidate", timeout=30)
            if result.get("ok"):
                print_ok("Gatcha candidate API works")
            else:
                print_warn(f"Gatcha candidate returned no song: {result.get('error')}")
        except Exception as exc:  # noqa: BLE001
            print_warn(f"Gatcha candidate skipped/failed: {exc}")

    def check_gatcha_uid_management_api(self) -> None:
        try:
            result = self.http_get("/api/gatcha/uids", timeout=10)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Gatcha UID snapshot API failed: {exc}") from exc
        data = result.get("data") if isinstance(result, dict) else {}
        uids = data.get("uids") if isinstance(data, dict) else None
        count = data.get("count") if isinstance(data, dict) else None
        if not isinstance(uids, list) or not isinstance(count, int):
            raise RuntimeError("Gatcha UID snapshot returned an invalid payload")
        if count != len(uids):
            raise RuntimeError(f"Gatcha UID snapshot count mismatch: count={count} len={len(uids)}")
        print_ok(f"Gatcha UID snapshot API works: {count} UID(s)")

        try:
            self.api_post("/api/gatcha/uids/preview", {"uid": "BV1xx411c7mD"}, timeout=10)
        except ApiError as exc:
            if exc.status != 400:
                raise RuntimeError(f"Gatcha UID preview invalid-input check returned HTTP {exc.status}") from exc
            print_ok("Gatcha UID preview rejects BV/video IDs before adding anything")
        else:
            raise RuntimeError("Gatcha UID preview accepted a BV/video ID")

        try:
            self.api_post("/api/gatcha/favlist", {"uid": "BV1xx411c7mD"}, timeout=10)
        except ApiError as exc:
            if exc.status != 400:
                raise RuntimeError(f"Gatcha favlist invalid-input check returned HTTP {exc.status}") from exc
            print_ok("Gatcha favlist pull rejects BV/video IDs before writing cache")
            return
        raise RuntimeError("Gatcha favlist pull accepted a BV/video ID")

    def check_follow_browse_api(self, label: str, *, remote: bool) -> None:
        try:
            result = self.http_get("/api/gatcha/browse", timeout=30, remote=remote)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"{label} API failed: {exc}") from exc
        if not isinstance(result, dict) or not result.get("ok"):
            raise RuntimeError(f"{label} API returned an error: {result.get('error') if isinstance(result, dict) else result}")
        data = result.get("data") if isinstance(result, dict) else {}
        owners = data.get("owners") if isinstance(data, dict) else []
        if not isinstance(owners, list):
            raise RuntimeError(f"{label} returned a non-list owners payload")
        print_ok(f"{label} owner grid API works: {len(owners)} owners")
        if not owners:
            print_skip(label, "No followed UID owners are configured")
            return

        owner = next(
            (
                entry for entry in owners
                if isinstance(entry, dict) and str(entry.get("uid") or "").strip()
            ),
            None,
        )
        if not owner:
            raise RuntimeError(f"{label} returned owners without UID values")
        uid = str(owner.get("uid") or "").strip()
        owner_name = str(owner.get("name") or "").strip() or f"UID {uid}"
        try:
            count = int(owner.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        selected = self.http_get(f"/api/gatcha/browse?uid={urllib.parse.quote(uid)}", timeout=30, remote=remote)
        selected_data = selected.get("data") if isinstance(selected, dict) else {}
        items = selected_data.get("items") if isinstance(selected_data, dict) else []
        items = items if isinstance(items, list) else []
        print_ok(f"{label} selected owner API works: {owner_name} ({uid}) items={len(items)} cached_count={count}")
        if items:
            first_title = str((items[0] or {}).get("title") or "").strip()
            if first_title:
                query = urllib.parse.quote(first_title[:8])
                filtered = self.http_get(
                    f"/api/gatcha/browse?uid={urllib.parse.quote(uid)}&q={query}",
                    timeout=30,
                    remote=remote,
                )
                filtered_items = (((filtered.get("data") or {}).get("items") or []) if isinstance(filtered, dict) else [])
                print_ok(f"{label} per-owner search works: {len(filtered_items)} result(s) for title prefix")

    def check_destructive_maintenance(self) -> None:
        print_header("Destructive data maintenance APIs")
        print_warn("About to test clear playlist, clear history, and clear data. This changes runtime data.")
        if not self.args.yes:
            confirm = input("Type YES to continue destructive checks: ").strip()
            if confirm != "YES":
                print_skip("Destructive data maintenance APIs", "User did not confirm")
                return
        self.api_post("/api/playlist/clear", {})
        print_ok("Clear playlist API works")
        self.api_post("/api/history/clear", {})
        print_ok("Clear history API works")
        self.api_post("/api/data/reset", {})
        print_ok("Clear data API works")

    def final_report(self) -> None:
        print_header("Done")
        state = self.get_state()
        self.print_state_summary(state, label="Final state")
        print_info("Final visual check: service settings, player, queue, remote QR, and BBDown login state.")
        print_info("Manual cookie input was intentionally not tested.")
        if not self.args.no_wait_at_end:
            input("Press Enter to finish and stop the server started by this script...")

    def api_post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        timeout: int | float = 20,
        remote: bool = False,
    ) -> dict[str, Any]:
        response = self.http_post(path, payload, timeout=timeout, remote=remote)
        if not response.get("ok"):
            raise ApiError(path, 200, response)
        data = response.get("data")
        return data if isinstance(data, dict) else response

    def get_state(self, *, timeout: int | float = 10, remote: bool = False) -> dict[str, Any]:
        response = self.http_get("/api/state", timeout=timeout, remote=remote)
        if not response.get("ok"):
            raise ApiError("/api/state", 200, response)
        data = response.get("data")
        if not isinstance(data, dict):
            raise RuntimeError("/api/state did not return object data")
        return data

    def request_headers(self, *, remote: bool = False, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"X-Bilikara-Client": REMOTE_CLIENT_ID if remote else CLIENT_ID}
        if remote:
            headers["Referer"] = f"{self.base_url}/remote"
        if extra:
            headers.update(extra)
        return headers

    def http_get(
        self,
        path: str,
        *,
        timeout: int | float = 10,
        expect_json: bool = True,
        remote: bool = False,
    ) -> Any:
        request = urllib.request.Request(
            self.base_url + path,
            headers=self.request_headers(remote=remote),
            method="GET",
        )
        return self.open_request(path, request, timeout=timeout, expect_json=expect_json)

    def http_download_get(
        self,
        path: str,
        *,
        timeout: int | float = 20,
        remote: bool = False,
    ) -> DownloadResponse:
        request = urllib.request.Request(
            self.base_url + path,
            headers=self.request_headers(remote=remote),
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return DownloadResponse(
                    body=response.read(),
                    content_type=response.headers.get("Content-Type", ""),
                    content_disposition=response.headers.get("Content-Disposition", ""),
                )
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {"ok": False, "error": raw or str(exc)}
            raise ApiError(path, exc.code, payload) from exc

    def http_post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        timeout: int | float = 20,
        remote: bool = False,
    ) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            headers=self.request_headers(
                remote=remote,
                extra={"Content-Type": "application/json; charset=utf-8"},
            ),
            method="POST",
        )
        return self.open_request(path, request, timeout=timeout, expect_json=True)

    def open_request(
        self,
        path: str,
        request: urllib.request.Request,
        *,
        timeout: int | float,
        expect_json: bool,
    ) -> Any:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
                if not expect_json:
                    return body
                return json.loads(body.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {"ok": False, "error": raw or str(exc)}
            raise ApiError(path, exc.code, payload) from exc

    @staticmethod
    def assert_download_filename(
        response: DownloadResponse,
        *,
        expected_fragment: str,
        expected_suffix: str,
    ) -> None:
        disposition = response.content_disposition
        if "attachment" not in disposition.lower():
            raise RuntimeError(f"Download response missing attachment disposition: {disposition}")
        filename = disposition
        if "filename*=" in disposition:
            filename = urllib.parse.unquote(disposition.split("filename*=", 1)[1].split("''", 1)[-1])
        elif "filename=" in disposition:
            filename = disposition.split("filename=", 1)[1].strip().strip('"')
        if expected_fragment not in filename or not filename.lower().endswith(expected_suffix):
            raise RuntimeError(f"Unexpected download filename: {filename}")

    @staticmethod
    def item_ids(state: dict[str, Any]) -> set[str]:
        ids: set[str] = set()
        current = state.get("current_item")
        if isinstance(current, dict) and current.get("id"):
            ids.add(str(current.get("id")))
        for item in state.get("playlist") or []:
            if isinstance(item, dict) and item.get("id"):
                ids.add(str(item.get("id")))
        return ids

    @staticmethod
    def find_item_not_in_ids(state: dict[str, Any], known_ids: set[str]) -> dict[str, Any] | None:
        current = state.get("current_item")
        if isinstance(current, dict) and current.get("id") and str(current.get("id") or "") not in known_ids:
            return current
        for item in state.get("playlist") or []:
            if isinstance(item, dict) and item.get("id") and str(item.get("id") or "") not in known_ids:
                return item
        return None

    @staticmethod
    def find_newest_item(state: dict[str, Any], *, prefer_playlist: bool = False) -> dict[str, Any] | None:
        playlist = state.get("playlist") or []
        if prefer_playlist and playlist:
            return playlist[-1]
        if playlist:
            return playlist[-1]
        current = state.get("current_item")
        return current if isinstance(current, dict) else None

    @staticmethod
    def find_item_by_id(state: dict[str, Any], item_id: str) -> dict[str, Any] | None:
        current = state.get("current_item")
        if isinstance(current, dict) and str(current.get("id") or "") == item_id:
            return current
        for item in state.get("playlist") or []:
            if isinstance(item, dict) and str(item.get("id") or "") == item_id:
                return item
        return None

    @staticmethod
    def rotated_users_after_current(state: dict[str, Any], current_requester: str, filter_users: list[str] | None = None) -> list[str]:
        users = [str(user).strip() for user in (state.get("session_users") or []) if str(user).strip()]
        if not users:
            return []
        normalized_current = str(current_requester or "").strip()
        if normalized_current in users:
            current_index = users.index(normalized_current)
            rotated = users[current_index + 1 :] + users[: current_index + 1]
        else:
            rotated = list(users)
        if not filter_users:
            return rotated
        allowed = {str(user).strip() for user in filter_users if str(user).strip()}
        return [user for user in rotated if user in allowed]

    @staticmethod
    def print_state_summary(state: dict[str, Any], *, label: str) -> None:
        current = state.get("current_item") or {}
        playlist = state.get("playlist") or []
        history = state.get("history") or []
        users = state.get("session_users") or []
        settings = state.get("player_settings") or {}
        bbdown = state.get("bbdown") or {}
        cache_policy = state.get("cache_policy") or {}
        print_info(
            f"{label}: mode={state.get('playback_mode')} current={current.get('display_title') or 'None'} "
            f"queue={len(playlist)} history={len(history)} users={users}"
        )
        print_info(
            "Player settings: "
            f"volume={settings.get('volume_percent')} muted={settings.get('is_muted')} "
            f"offset={settings.get('av_offset_ms')}ms delay={settings.get('song_advance_delay_seconds')}s"
        )
        print_info(
            "Tools/cache: "
            f"bbdown={bbdown.get('state')} logged_in={bbdown.get('logged_in')} "
            f"cache_items={cache_policy.get('cached_item_count')} usage={cache_policy.get('usage_bytes')} bytes"
        )

    @staticmethod
    def print_remote_access(state: dict[str, Any]) -> None:
        remote = state.get("remote_access") or {}
        print_info(f"Remote local_url: {remote.get('local_url')}")
        print_info(f"Remote preferred_url: {remote.get('preferred_url')}")
        lan_urls = remote.get("lan_urls") or []
        if lan_urls:
            print_info(f"Remote LAN URLs: {', '.join(map(str, lan_urls))}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Open the real bilikara host page and run developer smoke checks against the configured port.",
    )
    parser.add_argument(
        "--song-url",
        action="append",
        default=[],
        help="Bilibili URL used for song-request/cache/player tests. Repeat for multiple songs. If omitted, three URLs are picked from gatcha candidates.",
    )
    parser.add_argument(
        "--home",
        help="Optional BILIKARA_HOME for this run. This changes data/tool location only, not the frontend or port.",
    )
    parser.add_argument("--skip-bbdown-login", action="store_true", help="Skip QR login flow.")
    parser.add_argument("--force-bbdown-login", action="store_true", help="Logout first, then test QR login flow.")
    parser.add_argument("--bbdown-timeout", type=int, default=DEFAULT_BBDOWN_TIMEOUT_SECONDS)
    parser.add_argument("--cache-timeout", type=int, default=DEFAULT_CACHE_TIMEOUT_SECONDS)
    parser.add_argument("--cache-poll-interval", type=int, default=5)
    parser.add_argument("--visual-pause", type=float, default=DEFAULT_VISUAL_PAUSE_SECONDS)
    parser.add_argument("--transition-visual-pause", type=float, default=DEFAULT_TRANSITION_VISUAL_SECONDS)
    parser.add_argument("--destructive", action="store_true", help="Also test clear playlist/history/data endpoints.")
    parser.add_argument("--yes", action="store_true", help="Do not ask for destructive confirmation.")
    parser.add_argument("--non-interactive", action="store_true", help="Do not prompt for missing song URL.")
    parser.add_argument("--no-open-browser", action="store_true", help="Do not call webbrowser.open; prints URL only.")
    parser.add_argument("--no-wait-at-end", action="store_true", help="Exit immediately after checks.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.home:
        os.environ["BILIKARA_HOME"] = str(Path(args.home).expanduser())

    from bilikara.config import HOST, PORT

    browser_host = "127.0.0.1" if HOST in {"0.0.0.0", "::"} else HOST
    base_url = f"http://{browser_host}:{PORT}"

    handle = None if args.home else maybe_use_existing_server(base_url)
    if handle is None:
        handle = start_server_exact_port(HOST, PORT, base_url)

    runner = SmokeRunner(args, handle)
    try:
        runner.run()
        return 0
    except KeyboardInterrupt:
        print_warn("Interrupted by user.")
        return 130
    except Exception as exc:  # noqa: BLE001
        print_fail(str(exc))
        return 1
    finally:
        handle.stop()


def maybe_use_existing_server(base_url: str) -> ServerHandle | None:
    request = urllib.request.Request(base_url + "/api/state", headers={"X-Bilikara-Client": CLIENT_ID})
    try:
        with urllib.request.urlopen(request, timeout=1.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if payload.get("ok") and isinstance(payload.get("data"), dict):
        print_warn(f"Detected an existing bilikara service on this port; reusing it: {base_url}")
        return ServerHandle(base_url=base_url, started_here=False)
    return None


def start_server_exact_port(host: str, port: int, base_url: str) -> ServerHandle:
    from http.server import ThreadingHTTPServer

    from bilikara.server import BilikaraHandler, CONTEXT

    errors: "queue.Queue[BaseException]" = queue.Queue()
    try:
        server = ThreadingHTTPServer((host, port), BilikaraHandler)
    except OSError as exc:
        raise RuntimeError(
            f"Could not bind the configured port {host}:{port}. This script will not auto-switch ports; close the process using it or change BILIKARA_PORT before running."
        ) from exc

    CONTEXT.bind_server(server, shutdown_on_last_client=False)

    def serve() -> None:
        try:
            server.serve_forever()
        except BaseException as exc:  # noqa: BLE001
            errors.put(exc)

    thread = threading.Thread(target=serve, name="bilikara-dev-smoke-server", daemon=True)
    thread.start()
    time.sleep(0.3)
    if not errors.empty():
        raise RuntimeError(f"Server failed while starting: {errors.get()}")
    print_ok(f"Started service with current config: {base_url}")
    return ServerHandle(base_url=base_url, started_here=True, server=server, thread=thread, context=CONTEXT)


def console_text(value: object) -> str:
    return str(value).encode("ascii", "backslashreplace").decode("ascii")


def print_header(title: str) -> None:
    print(f"\n=== {console_text(title)} ===")


def print_step(message: str) -> None:
    print(f"[STEP] {console_text(message)}")


def print_info(message: str) -> None:
    print(f"[INFO] {console_text(message)}")


def print_ok(message: str) -> None:
    print(f"[ OK ] {console_text(message)}")


def print_warn(message: str) -> None:
    print(f"[WARN] {console_text(message)}")


def print_skip(name: str, reason: str) -> None:
    print(f"[SKIP] {console_text(name)}: {console_text(reason)}")


def print_fail(message: str) -> None:
    print(f"[FAIL] {console_text(message)}")


if __name__ == "__main__":
    raise SystemExit(main())
