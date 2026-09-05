from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RemotePlaybackDockTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        cls.markup = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")
        cls.script = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.translations = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )

    def run_node(self, source: str) -> dict:
        if not self.node:
            self.skipTest("node is unavailable")
        completed = subprocess.run(
            [self.node, "-"],
            input=source,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_dom_has_one_read_only_dock_one_sheet_and_one_control_owner(self):
        ids = re.findall(r'\bid="([^"]+)"', self.markup)
        self.assertEqual([item for item, count in Counter(ids).items() if count > 1], [])
        self.assertEqual(ids.count("playback-dock"), 1)
        self.assertEqual(ids.count("playback-sheet"), 1)
        self.assertEqual(ids.count("player-control-panel"), 1)
        self.assertNotIn("now-playing-panel", self.markup)
        self.assertNotIn("floating-control-trigger", self.markup)
        self.assertNotIn("floating-player-control-panel", self.markup)

        dock = re.search(
            r'<button\s+type="button"\s+id="playback-dock".*?</button>',
            self.markup,
            re.DOTALL,
        ).group(0)
        self.assertIn('aria-haspopup="dialog"', dock)
        self.assertIn('aria-controls="playback-sheet"', dock)
        self.assertIn('aria-expanded="false"', dock)
        self.assertEqual(dock.count("<button"), 1)
        for interactive in ("<a ", "<input", "<select", "<textarea"):
            self.assertNotIn(interactive, dock)
        self.assertNotIn("data-control-action", dock)
        self.assertNotIn("chevron", dock.lower())
        self.assertNotIn("grabber", dock.lower())
        self.assertEqual(dock.count('class="playback-dock-marquee-text"'), 2)

    def test_sheet_header_and_content_order_match_the_product_contract(self):
        sheet = self.markup[
            self.markup.index('id="playback-sheet"') :
            self.markup.index('id="remote-identity-modal"')
        ]
        header = sheet[: sheet.index('id="playback-sheet-body"')]
        self.assertLess(header.index('id="playback-sheet-title"'), header.index('id="playback-sheet-collapse"'))
        self.assertLess(header.index('id="playback-sheet-collapse"'), header.index('id="open-rating-button"'))
        self.assertLess(header.index('id="open-rating-button"'), header.index('id="refresh-button"'))
        collapse = re.search(
            r'<button[^>]+id="playback-sheet-collapse".*?</button>',
            header,
            re.DOTALL,
        ).group(0)
        self.assertIn('type="button"', collapse)
        self.assertIn('data-i18n-aria-label="remote.collapsePlaybackControls"', collapse)
        self.assertIn("<svg", collapse)
        self.assertIn('d="m5 9 7 7 7-7"', collapse)

        sequence = (
            'class="playback-sheet-summary"',
            'id="audio-variant-bar"',
            'id="player-control-panel"',
            'class="playback-sheet-secondary"',
        )
        positions = [sheet.index(marker) for marker in sequence]
        self.assertEqual(positions, sorted(positions))
        panel_start = sheet.index('id="player-control-panel"')
        panel = sheet[panel_start : sheet.index("</section>", panel_start)]
        self.assertEqual(
            re.findall(r'data-control-action="([^"]+)"', panel),
            [
                "seek-relative",
                "toggle-play",
                "seek-relative",
                "seek-absolute",
                "next-track",
            ],
        )
        self.assertEqual(re.findall(r'data-delta="([^"]+)"', panel), ["-15", "15"])
        self.assertIn('id="playback-sheet-seek"', panel)
        self.assertIn('type="range"', panel)
        self.assertIn('id="playback-sheet-current-time"', panel)
        self.assertIn('id="playback-sheet-duration"', panel)
        self.assertNotIn("playback-sheet-progress-block", sheet)

        settings = re.search(
            r'<div class="playback-sheet-settings-card">.*?</div>\s*</section>\s*</div>',
            sheet,
            re.DOTALL,
        ).group(0)
        self.assertIn(
            'class="playback-sheet-secondary" aria-label="设置" data-i18n-aria-label="settings.title"',
            sheet,
        )
        self.assertNotIn("playback-sheet-settings-title", sheet)
        self.assertEqual(settings.count('class="remote-setting-panel"'), 3)
        for panel_id in ("remote-av-sync-panel", "remote-volume-panel", "remote-key-shift-panel"):
            self.assertIn(f'id="{panel_id}"', settings)

    def test_cover_contract_reuses_normalizer_and_has_fixed_fallbacks(self):
        self.assertIn(
            "window.BilikaraSongDetail?.normalizeBilibiliImageUrl?.(rawCoverUrl)",
            self.script,
        )
        self.assertIn("return safeHttpUrl(normalizedCoverUrl);", self.script)
        self.assertEqual(self.markup.count('class="playback-cover-fallback" src="/pic/icon.png"'), 2)
        self.assertEqual(self.markup.count('class="playback-cover-image hidden"'), 2)
        for image_id in ("playback-dock-cover-image", "playback-sheet-cover-image"):
            image = re.search(rf'<img[^>]+id="{image_id}"[^>]+>', self.markup, re.DOTALL).group(0)
            self.assertIn('referrerpolicy="no-referrer"', image)
            self.assertIn('decoding="async"', image)
            self.assertIn('alt=""', image)
        self.assertNotIn("/api/cover", self.script)
        self.assertNotIn("/api/metadata", self.script)

    def test_cover_sync_avoids_duplicate_requests_and_rejects_late_errors(self):
        cover_source = self.script[
            self.script.index("function safeHttpUrl") :
            self.script.index("function ratingOwnerUid")
        ]
        result = self.run_node(
            f"""
class ClassList {{
  constructor() {{ this.values = new Set(["hidden"]); }}
  add(name) {{ this.values.add(name); }}
  remove(name) {{ this.values.delete(name); }}
  toggle(name, force) {{ if (force) this.add(name); else this.remove(name); return Boolean(force); }}
  contains(name) {{ return this.values.has(name); }}
}}
class Image {{
  constructor() {{ this.dataset = {{}}; this.classList = new ClassList(); this.assignments = 0; this.attributes = new Set(); }}
  set src(value) {{ this._src = value; this.assignments += 1; this.attributes.add("src"); }}
  get src() {{ return this._src || ""; }}
  removeAttribute(name) {{ this.attributes.delete(name); if (name === "src") this._src = ""; }}
}}
const window = {{
  location: {{ href: "https://remote.test/remote" }},
  BilikaraSongDetail: {{
    normalizeBilibiliImageUrl(value) {{
      if (value.startsWith("//")) return `https:${{value}}`;
      if (value.startsWith("http://") && value.includes("hdslb.com")) return `https://${{value.slice(7)}}`;
      return value;
    }},
  }},
}};
{cover_source}
const image = new Image();
const protocolRelative = normalizedPlaybackCoverUrl({{ cover_url: "//i0.hdslb.com/a.jpg" }});
const normalizedHttp = normalizedPlaybackCoverUrl({{ cover_url: "http://i1.hdslb.com/b.jpg" }});
const unsafe = normalizedPlaybackCoverUrl({{ cover_url: "javascript:alert(1)" }});
syncPlaybackCoverImage(image, protocolRelative, "g1|i1");
const oldError = image.onerror;
syncPlaybackCoverImage(image, protocolRelative, "g1|i1");
const assignmentsAfterRepeat = image.assignments;
syncPlaybackCoverImage(image, protocolRelative, "g2|same-cover");
const sameCoverLoad = image.onload;
sameCoverLoad();
oldError();
const visibleAfterSameCoverLateError = !image.classList.contains("hidden");
const assignmentsAfterIdentityChange = image.assignments;
syncPlaybackCoverImage(image, normalizedHttp, "g3|i2");
const newLoad = image.onload;
newLoad();
oldError();
const visibleAfterLateError = !image.classList.contains("hidden");
image.onerror();
const hiddenAfterCurrentError = image.classList.contains("hidden");
syncPlaybackCoverImage(image, normalizedHttp, "g2|i2");
const assignmentsAfterFailedRepeat = image.assignments;
syncPlaybackCoverImage(image, "", "empty");
console.log(JSON.stringify({{
  protocolRelative,
  normalizedHttp,
  unsafe,
  assignmentsAfterRepeat,
  visibleAfterSameCoverLateError,
  assignmentsAfterIdentityChange,
  visibleAfterLateError,
  hiddenAfterCurrentError,
  assignmentsAfterFailedRepeat,
  srcRemoved: !image.attributes.has("src"),
}}));
"""
        )
        self.assertEqual(result["protocolRelative"], "https://i0.hdslb.com/a.jpg")
        self.assertEqual(result["normalizedHttp"], "https://i1.hdslb.com/b.jpg")
        self.assertEqual(result["unsafe"], "")
        self.assertEqual(result["assignmentsAfterRepeat"], 1)
        self.assertTrue(result["visibleAfterSameCoverLateError"])
        self.assertEqual(result["assignmentsAfterIdentityChange"], 1)
        self.assertTrue(result["visibleAfterLateError"])
        self.assertTrue(result["hiddenAfterCurrentError"])
        self.assertEqual(result["assignmentsAfterFailedRepeat"], 2)
        self.assertTrue(result["srcRemoved"])

    def test_clock_progress_uses_one_paint_path_and_one_timer(self):
        self.assertEqual(
            self.script.count("window.setInterval(paintCurrentPlaybackClock, 1000)"),
            1,
        )
        clock_source = self.script[
            self.script.index("function formatPlaybackClockSeconds") :
            self.script.index("function formatBytes")
        ]
        self.assertIn("paintPlaybackClockSurfaces();", clock_source)
        self.assertIn("playbackDockClock", clock_source)
        self.assertIn("playbackSheetClock", clock_source)
        self.assertIn("playbackSheetCurrentTime", clock_source)
        self.assertIn("playbackSheetDuration", clock_source)
        self.assertIn("playbackSheetSeek", clock_source)
        self.assertIn("setRangeFillPercent(elements.playbackSheetSeek, ratio * 100)", clock_source)
        self.assertIn("style.transform = `scaleX(${ratio})`", clock_source)
        progress_rule = re.search(r"\.playback-dock-progress\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("background: var(--accent-soft)", progress_rule)
        self.assertIn("transform: scaleX(0)", progress_rule)
        self.assertIn("transform-origin: left center", progress_rule)
        self.assertNotIn("width:", progress_rule)
        self.assertNotIn("transition:", progress_rule)
        self.assertNotIn("border-radius:", progress_rule)
        self.assertNotIn("--playback-progress-fill", self.styles)

    def test_ratio_is_finite_clamped_and_unknown_duration_is_hidden(self):
        ratio_source = self.script[
            self.script.index("function playbackProgressRatio") :
            self.script.index("function paintPlaybackClockSurfaces")
        ]
        result = self.run_node(
            f"""
{ratio_source}
console.log(JSON.stringify({{
  zero: playbackProgressRatio(1, 0),
  nan: playbackProgressRatio(Number.NaN, 20),
  low: playbackProgressRatio(-5, 20),
  middle: playbackProgressRatio(5, 20),
  high: playbackProgressRatio(25, 20),
}}));
"""
        )
        self.assertEqual(result, {"zero": 0, "nan": 0, "low": 0, "middle": 0.25, "high": 1})
        self.assertIn('classList.toggle("is-unknown-duration", !hasKnownDuration)', self.script)
        self.assertIn('classList.toggle("has-progress", hasKnownDuration)', self.script)

    def test_safe_area_cover_progress_and_ready_state_match_review_delta(self):
        dock_rule = re.search(r"\.playback-dock\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("bottom: calc(12px + env(safe-area-inset-bottom, 0px))", dock_rule)
        self.assertIn("left: calc(12px + env(safe-area-inset-left, 0px))", dock_rule)
        self.assertIn("right: calc(12px + env(safe-area-inset-right, 0px))", dock_rule)
        self.assertIn("viewport-fit=cover", self.markup)

        dock_cover_rule = re.search(r"\.playback-dock-cover\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("width: 82px", dock_cover_rule)
        self.assertIn("height: 46px", dock_cover_rule)
        self.assertIn("z-index: 1", dock_cover_rule)
        self.assertIn("background: var(--playback-dock-bg)", dock_cover_rule)
        sheet_cover_rule = re.search(r"\.playback-sheet-cover\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("aspect-ratio: 16 / 9", sheet_cover_rule)

        self.assertEqual(self.markup.count('class="playback-sheet-settings-card"'), 1)
        self.assertIn(".player-progress-times", self.styles)
        self.assertIn(".player-progress-range::-webkit-slider-thumb", self.styles)
        self.assertNotIn("playback-sheet-progress-block", self.markup)
        self.assertIn("function mountRemoteContextualTooltip(wrap)", self.script)
        self.assertIn("playbackPanel.append(tooltip)", self.script)
        self.assertIn("const widthLimit = Math.min(320,", self.script)
        self.assertIn('tooltip.style.width = "max-content"', self.script)
        self.assertIn("tooltip.style.maxWidth", self.script)

    def test_toast_is_above_every_remote_playback_and_access_overlay(self):
        layer_names = ("dock", "modal", "gate", "toast")
        layers = {
            name: int(re.search(rf"--remote-layer-{name}:\s*(\d+)", self.styles).group(1))
            for name in layer_names
        }
        self.assertEqual(
            [layers[name] for name in layer_names],
            sorted(layers.values()),
        )
        selector_layers = {
            ".playback-dock": "dock",
            ".request-panel > .song-detail-view": "modal",
            ".playback-sheet": "modal",
            ".binding-sheet": "modal",
            ".rating-modal": "modal",
            ".remote-identity-modal": "gate",
            ".internet-remote-join-overlay": "gate",
            ".app-toast": "toast",
        }
        for selector, layer in selector_layers.items():
            rule = re.search(rf"{re.escape(selector)}\s*\{{([^}}]*)\}}", self.styles).group(1)
            self.assertIn(f"z-index: var(--remote-layer-{layer})", rule, selector)

    def test_overflowing_dock_copy_uses_one_shot_measurement_and_reduced_motion_fallback(self):
        marquee_source = self.script[
            self.script.index("function setPlaybackDockMarqueeText") :
            self.script.index("function ratingOwnerUid")
        ]
        self.assertIn("textNode.scrollWidth", marquee_source)
        self.assertIn("container.clientWidth", marquee_source)
        self.assertIn('container.classList.add("is-scrolling")', marquee_source)
        self.assertIn("window.requestAnimationFrame", marquee_source)
        self.assertNotIn("setInterval", marquee_source)
        self.assertNotIn("requestAnimationFrame(() => requestAnimationFrame", marquee_source)
        self.assertIn("@keyframes playback-dock-marquee", self.styles)
        reduced_motion = self.styles[
            self.styles.index("@media (prefers-reduced-motion: reduce)") :
        ]
        self.assertIn(".playback-dock-title.is-scrolling", reduced_motion)
        self.assertIn("animation: none", reduced_motion)
        tooltip_rule = re.search(r"\.remote-tooltip-bubble\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("width: max-content", tooltip_rule)
        self.assertIn("max-width: min(320px, calc(100vw - 48px))", tooltip_rule)
        self.assertIn('let direction = "up";', self.script)
        self.assertIn("spaceAbove < height && spaceBelow >= height", self.script)
        tooltip_owner_rule = re.search(
            r"\.playback-sheet-panel > \.remote-tooltip-bubble\.is-portaled\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("z-index: 30", tooltip_owner_rule)
        volume_panel = self.markup[
            self.markup.index('id="remote-volume-panel"') :
            self.markup.index('id="remote-key-shift-panel"')
        ]
        self.assertNotIn("remote-info-button", volume_panel)
        self.assertNotIn("remote-volume-info", volume_panel)

        cache_label_source = self.script[
            self.script.index("function currentCacheStateLabel") :
            self.script.index("function cacheProgressPercentForItem")
        ]
        result = self.run_node(
            f"""
{cache_label_source}
console.log(JSON.stringify({{ ready: currentCacheStateLabel({{ cache_status: "ready" }}) }}));
"""
        )
        self.assertEqual(result["ready"], "")
        cache_sync_source = self.script[
            self.script.index("function syncCurrentCacheState") :
            self.script.index("function currentCacheStateLabel")
        ]
        self.assertIn('classList.toggle("hidden", !label && !showRetry)', cache_sync_source)

    def test_audio_variant_bar_is_one_row_with_one_scrollable_popover_owner(self):
        render_source = self.script[
            self.script.index("function audioVariantPopover") :
            self.script.index("function boundedRemoteVolumePercent")
        ]
        self.assertEqual(self.markup.count('id="audio-variant-popover"'), 1)
        self.assertGreater(
            self.markup.index('id="audio-variant-popover"'),
            self.markup.index('id="playback-sheet-body"'),
        )
        self.assertIn(
            'audioVariantPopover: document.getElementById("audio-variant-popover")',
            self.script,
        )
        self.assertIn("return elements.audioVariantPopover", render_source)
        self.assertIn('summary.className = "audio-variant-summary"', render_source)
        self.assertIn('summaryLabel.className = "audio-variant-summary-label"', render_source)
        self.assertIn('label.className = "audio-variant-button-label"', render_source)
        self.assertIn('toggleButton.setAttribute("aria-controls", "audio-variant-popover")', render_source)
        self.assertIn('toggleButton.setAttribute("aria-haspopup", "true")', render_source)
        self.assertIn("popover.hidden = !nextOpen", render_source)
        self.assertIn("window.requestAnimationFrame(positionAudioVariantPopover)", render_source)
        self.assertIn('const direction = spaceAbove >= minimumUsefulHeight ? "up" : "down"', render_source)
        self.assertIn("elements.audioVariantPopover?.replaceChildren(list)", render_source)
        self.assertIn(
            'document.createElementNS("http://www.w3.org/2000/svg", "svg")',
            render_source,
        )
        self.assertIn('togglePath.setAttribute("d", "m6 9 6 6 6-6")', render_source)
        self.assertNotIn("toggleIcon.textContent", render_source)
        self.assertEqual(render_source.count('button.className = "audio-variant-button"'), 1)
        self.assertEqual(render_source.count("list.appendChild(button)"), 1)

        bar_rule = re.search(r"\.audio-variant-bar\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("grid-template-columns: minmax(0, 1fr) 44px", bar_rule)
        self.assertIn("min-height: 44px", bar_rule)
        summary_rule = re.search(r"\.audio-variant-summary\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("height: 44px", summary_rule)
        self.assertNotIn("border:", summary_rule)
        summary_label_rule = re.search(
            r"\.audio-variant-summary-label\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("overflow: hidden", summary_label_rule)
        self.assertIn("white-space: nowrap", summary_label_rule)
        self.assertIn("text-overflow: ellipsis", summary_label_rule)
        popover_rule = re.search(r"\.audio-variant-popover\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("position: absolute", popover_rule)
        self.assertIn("z-index: 40", popover_rule)
        self.assertIn("overflow-y: auto", popover_rule)
        self.assertIn("max-height: 240px", popover_rule)
        self.assertIn("touch-action: pan-y", popover_rule)
        self.assertIn("background: var(--audio-variant-popover-bg)", popover_rule)
        button_label_rule = re.search(
            r"\.audio-variant-button-label\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("overflow: hidden", button_label_rule)
        self.assertIn("white-space: nowrap", button_label_rule)
        self.assertIn("text-overflow: ellipsis", button_label_rule)
        toggle_icon_rule = re.search(
            r"\.audio-variant-toggle svg\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("width: 18px", toggle_icon_rule)
        self.assertIn("height: 18px", toggle_icon_rule)

        listener_source = self.script[
            self.script.index('elements.audioVariantBar.addEventListener("click"') :
            self.script.index('elements.playerControlPanel.addEventListener("click"')
        ]
        self.assertIn("setAudioVariantPopoverOpen(!state.audioVariantBarExpanded)", listener_source)
        self.assertIn('elements.audioVariantPopover?.addEventListener("click"', listener_source)
        self.assertIn("setAudioVariantPopoverOpen(false)", listener_source)
        self.assertNotIn("fetch(", listener_source)

    def test_modal_contract_has_no_gestures_and_restores_dock_focus(self):
        sheet_source = self.script[
            self.script.index("function playbackSheetIsOpen") :
            self.script.index("async function startRemoteSession")
        ]
        for forbidden in (
            "touchstart",
            "touchmove",
            "touchend",
            "pointermove",
            "mousedown",
            "mousemove",
            "requestAnimationFrame",
        ):
            self.assertNotIn(forbidden, sheet_source)
        self.assertIn('elements.playbackDock?.addEventListener("click", openPlaybackSheet)', sheet_source)
        self.assertIn('elements.playbackSheetCollapse?.addEventListener("click"', sheet_source)
        self.assertIn('elements.playbackSheetBackdrop?.addEventListener("click"', sheet_source)
        self.assertIn('elements.playbackDock.focus({ preventScroll: true })', sheet_source)
        self.assertIn('elements.playbackSheetCollapse?.focus?.({ preventScroll: true })', sheet_source)
        self.assertIn('document.body.classList.add("playback-sheet-scroll-locked")', sheet_source)
        self.assertIn("window.scrollTo(0, lock.scrollY)", sheet_source)
        self.assertIn("if (immediate || prefersReducedMotion())", sheet_source)

    def test_other_true_modals_retire_playback_ownership_first(self):
        modal_openers = (
            ("function openBindingSheet", "function closeBindingSheet"),
            ("function openGatchaFavlistSheet", "function closeGatchaFavlistSheet"),
            ("async function openPoolConfigSheet", "function closePoolConfigSheet"),
            ("function openReorderConfirmSheet", "function closeReorderConfirmSheet"),
        )
        for start_marker, end_marker in modal_openers:
            source = self.script[
                self.script.index(start_marker) : self.script.index(end_marker)
            ]
            self.assertIn("retireTransientPlaybackModalForModal();", source)

        identity_render = self.script[
            self.script.index("function renderRemoteIdentity") :
            self.script.index("function applyRemoteIdentity")
        ]
        self.assertIn("retireTransientPlaybackModalForModal();", identity_render)
        rating_open = self.script[
            self.script.index("function openRatingPrompt") :
            self.script.index("function currentPlaybackClockSeconds")
        ]
        self.assertIn("const returnFocusToDock = retirePlaybackSheetForModal();", rating_open)
        escape_owner = self.script[
            self.script.index('document.addEventListener("keydown", (event) => {') :
            self.script.index('document.addEventListener("visibilitychange"')
        ]
        self.assertLess(
            escape_owner.index("if (state.ratingPromptElement)"),
            escape_owner.index("else if (state.audioVariantBarExpanded)"),
        )
        self.assertLess(
            escape_owner.index("else if (state.audioVariantBarExpanded)"),
            escape_owner.index("else if (playbackSheetIsOpen())"),
        )

    def test_sheet_css_uses_measured_two_column_threshold_and_one_scroller(self):
        header_rule = re.search(r"\.playback-sheet-status-header\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)", header_rule)
        body_rule = re.search(r"\.playback-sheet-body\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("overflow-y: auto", body_rule)
        self.assertIn("overflow-x: hidden", body_rule)
        for column in (".playback-sheet-primary", ".playback-sheet-secondary"):
            rule = self.styles[self.styles.index(column) :].split("}", 1)[0]
            self.assertNotIn("overflow-y", rule)
        self.assertIn("@media (min-width: 700px)", self.styles)
        self.assertIn("@media (min-width: 700px) and (max-height: 520px)", self.styles)
        portrait_rule = self.styles[
            self.styles.index("@media (max-width: 699px) and (min-height: 521px)") :
            self.styles.index("@media (max-width: 360px)")
        ]
        self.assertIn("padding-top: 0", portrait_rule)
        self.assertIn("max-height: 100dvh", portrait_rule)
        self.assertIn("env(safe-area-inset-top, 0px)", portrait_rule)
        self.assertIn("width: min(880px, 100%)", self.styles)
        self.assertNotIn("repeat(3", self.styles[self.styles.index("/* Remote playback dock") :])

    def test_new_accessible_labels_exist_in_all_languages(self):
        for messages in self.translations["languages"].values():
            for key in (
                "remote.openPlaybackControls",
                "remote.collapsePlaybackControls",
                "remote.playbackControlsTitle",
                "remote.playbackGroupLabel",
                "remote.transportControlsLabel",
                "remote.fullMetadataText",
                "remote.showFullTitle",
                "remote.showFullRequester",
                "remote.showFullOwner",
            ):
                self.assertTrue(messages.get(key), key)
            self.assertTrue(messages.get("remote.controlSentSeek"))
        self.assertEqual(
            {
                language: messages["player.tag"]
                for language, messages in self.translations["languages"].items()
            },
            {"zh": "正在播放", "en": "Now Playing", "ja": "再生中"},
        )

    def test_transport_strip_uses_one_stable_svg_control_tree(self):
        sheet = self.markup[
            self.markup.index('id="playback-sheet"') :
            self.markup.index('id="remote-identity-modal"')
        ]
        panel_start = sheet.index('id="player-control-panel"')
        panel = sheet[panel_start : sheet.index("</section>", panel_start)]
        buttons = re.findall(r"<button\b.*?</button>", panel, re.DOTALL)
        self.assertEqual(len(buttons), 4)
        self.assertTrue(all("<svg" in button for button in buttons))
        self.assertEqual(panel.count('data-player-icon="play"'), 1)
        self.assertEqual(panel.count('data-player-icon="pause"'), 1)
        self.assertEqual(panel.count("<svg"), 5)
        for emoji in ("⏪", "⏩", "⏯", "⏭", "▶️", "⏸️", "🔁"):
            self.assertNotIn(emoji, panel)
        self.assertEqual(panel.count('dominant-baseline="central"'), 2)
        self.assertEqual(panel.count('transform="translate(0 2)"'), 2)

        play_icon_rule = re.search(
            r"\.player-control-row \.player-play-toggle svg\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        next_icon_rule = re.search(
            r"\.player-control-row \.player-next-button svg\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        seek_icon_rule = re.search(
            r"\.player-control-row \.player-seek-button svg\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("width: 30px", play_icon_rule)
        self.assertIn("height: 30px", play_icon_rule)
        self.assertIn("width: 28px", next_icon_rule)
        self.assertIn("height: 28px", next_icon_rule)
        self.assertIn("place-self: center", seek_icon_rule)

        render_start = self.script.index("function renderPlayerControls")
        render_source = self.script[
            render_start : self.script.index("function renderListHeader", render_start)
        ]
        self.assertNotIn("btn.textContent", render_source)
        self.assertNotIn("innerHTML", render_source)
        self.assertIn('querySelector(\'[data-player-icon="play"]\')', render_source)
        self.assertIn('querySelector(\'[data-player-icon="pause"]\')', render_source)
        self.assertIn('setAttribute("aria-pressed", String(!isPaused))', render_source)

    def test_transport_grid_keeps_one_row_at_375_and_320_widths(self):
        row_rule = re.search(r"\.player-control-row\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn(
            "grid-template-columns: 44px 48px 44px minmax(88px, 1fr) 44px",
            row_rule,
        )
        self.assertIn("gap: clamp(4px, 1.2vw, 6px)", row_rule)
        self.assertIn("max-width: 520px", row_rule)
        progress_rule = re.search(r"\.player-progress-unit\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("min-width: 88px", progress_rule)
        self.assertIn("height: 48px", progress_rule)
        range_rule = re.search(r"\.player-progress-range\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("height: 44px", range_rule)
        transport_button_rule = re.search(
            r"\.player-control-row \.player-transport-button\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        for declaration in ("width: 44px", "min-width: 44px", "height: 44px"):
            self.assertIn(declaration, transport_button_rule)
        phone_rules = self.styles[
            self.styles.index("@media (max-width: 520px)") :
            self.styles.index("@media (max-width: 420px)")
        ]
        self.assertNotIn(".player-control-row", phone_rules)

    def test_metadata_allocation_is_priority_driven_and_tick_independent(self):
        self.assertEqual(self.markup.count('data-playback-metadata-field="title"'), 1)
        self.assertEqual(self.markup.count('data-playback-metadata-field="requester"'), 1)
        self.assertEqual(self.markup.count('data-playback-metadata-field="owner"'), 1)
        self.assertEqual(self.markup.count('id="playback-metadata-popover"'), 1)
        self.assertEqual(self.markup.count('id="playback-metadata-popover-text"'), 1)

        adaptive = self.script[
            self.script.index("function playbackMetadataEntries") :
            self.script.index("function renderCurrentItem")
        ]
        self.assertIn('for (const key of ["title", "requester", "owner"])', adaptive)
        self.assertIn("if (fittingExtraLines < availableExtraLines)", adaptive)
        self.assertIn("break;", adaptive)
        self.assertIn("naturalLines", adaptive)
        self.assertIn("visibleLines", adaptive)
        self.assertIn("availableSummaryHeight", adaptive)
        self.assertIn("playbackSheetMaximumPanelHeight()", adaptive)
        self.assertIn("window.visualViewport?.height", adaptive)
        self.assertNotIn("currentPlaybackClockSeconds", adaptive)
        self.assertNotIn("setInterval", adaptive)
        self.assertNotIn("EventSource", adaptive)
        self.assertNotIn("ResizeObserver", adaptive)
        self.assertEqual(adaptive.count("window.requestAnimationFrame"), 1)

        clock = self.script[
            self.script.index("function paintPlaybackClockSurfaces") :
            self.script.index("function clearCurrentPlaybackClock")
        ]
        self.assertNotIn("schedulePlaybackSheetAdaptiveLayout", clock)

        field_rule = re.search(
            r"\.playback-metadata-field\.is-clamped \.playback-metadata-text\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("-webkit-line-clamp: var(--playback-metadata-lines, 1)", field_rule)
        self.assertIn("overflow: hidden", field_rule)
        owner_rule = re.search(
            r'\.playback-metadata-field\[data-playback-metadata-field="owner"\] '
            r"\.owner-badge-name\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("white-space: normal", owner_rule)
        self.assertIn("overflow-wrap: anywhere", owner_rule)

    def test_full_text_popover_is_one_non_modal_text_only_owner(self):
        popover = re.search(
            r'<div\s+id="playback-metadata-popover".*?</div>',
            self.markup,
            re.DOTALL,
        ).group(0)
        self.assertIn('role="tooltip"', popover)
        self.assertNotIn('aria-modal="true"', popover)
        self.assertIn('data-i18n-aria-label="remote.fullMetadataText"', popover)
        self.assertNotIn('tabindex="0"', popover)

        source = self.script[
            self.script.index("function clearPlaybackMetadataPopoverPosition") :
            self.script.index("function playbackCssPixels")
        ]
        self.assertIn("elements.playbackMetadataPopoverText.textContent = fullText", source)
        self.assertNotIn("innerHTML", source)
        self.assertIn('field === "owner"', source)
        self.assertIn('.querySelector(".owner-badge-name")', source)
        self.assertIn("closePlaybackMetadataPopover()", source)
        self.assertIn("positionPlaybackMetadataPopover()", source)
        self.assertIn("setAudioVariantPopoverOpen(false)", source)
        self.assertIn("closeRemoteContextualInfo()", source)
        self.assertNotIn("playbackMetadataPopover.focus", source)
        self.assertIn("Math.min(320, boundaryRight - boundaryLeft)", source)

        event_source = self.script[
            self.script.index('elements.playbackSheetSummaryCopy?.addEventListener("click"') :
            self.script.index('elements.refreshButton.addEventListener("click"')
        ]
        self.assertIn('event.key !== "Enter" && event.key !== " "', event_source)
        self.assertIn('!event.target.closest("#playback-metadata-popover")', event_source)
        self.assertIn("closePlaybackMetadataPopover({ restoreFocus: true })", event_source)
        escape_source = self.script[
            self.script.index('document.addEventListener("keydown"') :
            self.script.index('window.addEventListener("resize", scheduleRemoteContextualTooltipPositionSync)')
        ]
        self.assertLess(
            escape_source.index("closePlaybackMetadataPopover({ restoreFocus: true })"),
            escape_source.index("closeRemoteContextualInfo()"),
        )
        popover_rule = re.search(
            r"\.playback-metadata-popover\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        for declaration in (
            "z-index: 45",
            "overflow: auto",
            "user-select: text",
            "overscroll-behavior: contain",
        ):
            self.assertIn(declaration, popover_rule)
        self.assertNotIn("color:", popover_rule)
        self.assertNotIn("max-width:", popover_rule)

    def test_remote_setting_state_icons_are_stable_inline_svg_nodes(self):
        for button_id, attribute, states in (
            ("remote-av-delay-lock-button", "data-av-lock-icon", ("unlocked", "locked")),
            ("remote-volume-mute-button", "data-volume-icon", ("unmuted", "muted")),
        ):
            button = re.search(
                rf'<button[^>]+id="{button_id}".*?</button>',
                self.markup,
                re.DOTALL,
            ).group(0)
            self.assertEqual(button.count("<svg"), 2)
            self.assertNotRegex(button, r"[🔊🔇🔓🔒]")
            for state_name in states:
                self.assertEqual(button.count(f'{attribute}="{state_name}"'), 1)
            self.assertEqual(button.count('aria-hidden="true"'), 2)
            self.assertEqual(button.count('focusable="false"'), 2)

        icon_source = self.script[
            self.script.index("function setRemoteIconVisibility") :
            self.script.index("function renderRemoteKeyShiftControls")
        ]
        self.assertIn('icon.classList.toggle("hidden"', icon_source)
        self.assertIn('"data-av-lock-icon"', icon_source)
        self.assertIn('"data-volume-icon"', icon_source)
        self.assertNotIn("remoteAvDelayLockButton.textContent", icon_source)
        self.assertNotIn("remoteVolumeMuteButton.textContent", icon_source)

        wide = self.styles[self.styles.index("@media (min-width: 700px)") :]
        self.assertIn("scrollbar-gutter: stable both-edges", wide)

    def test_sheet_is_content_sized_and_transport_reuses_one_dom_in_two_modes(self):
        body_rule = re.search(r"\.playback-sheet-body\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("flex: 0 1 auto", body_rule)
        self.assertIn("padding: 14px 16px calc(10px + env(safe-area-inset-bottom, 0px))", body_rule)
        primary_rule = re.search(r"\.playback-sheet-primary\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("display: flex", primary_rule)
        self.assertIn("flex-direction: column", primary_rule)
        wide = self.styles[self.styles.index("@media (min-width: 700px)") :]
        self.assertIn(".playback-sheet-primary .playback-sheet-playback-group", wide)
        self.assertIn("margin-top: auto", wide)

        self.assertEqual(self.markup.count('class="player-control-row"'), 1)
        self.assertEqual(self.markup.count('class="player-control-row" role="group"'), 1)
        self.assertEqual(self.markup.count('id="playback-sheet-seek"'), 1)
        spacious = re.search(
            r"\.playback-sheet-panel\.is-spacious-transport \.player-control-row\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn('"progress progress progress progress progress"', spacious)
        self.assertIn('"back play forward . next"', spacious)
        self.assertIn("grid-template-rows: 48px 48px", spacious)
        self.assertIn("row-gap: 8px", spacious)

        adaptive = self.script[
            self.script.index("function applyPlaybackSheetAdaptiveLayout") :
            self.script.index("function renderCurrentItem")
        ]
        self.assertIn("rangeGain >= 96", adaptive)
        self.assertIn("const clearance = 10", adaptive)
        self.assertIn("secondaryNaturalHeight <= maximumBodyContentHeight + 0.5", adaptive)
        self.assertIn("panel.dataset.transportLayout", adaptive)
        self.assertNotIn("cloneNode", adaptive)
        self.assertNotIn("replaceChildren", adaptive)

    def test_header_actions_keep_refresh_last_and_use_measured_large_text_fallback(self):
        sheet = self.markup[
            self.markup.index('id="playback-sheet"') :
            self.markup.index('id="playback-sheet-body"')
        ]
        self.assertLess(sheet.index('id="open-rating-button"'), sheet.index('id="refresh-button"'))
        source = self.script[
            self.script.index("function syncPlaybackSheetHeaderActionLayout") :
            self.script.index("function applyPlaybackSheetAdaptiveLayout")
        ]
        self.assertIn("requiredWidth > actions.getBoundingClientRect().width + 0.5", source)
        self.assertIn('header.classList.toggle("is-stacked-actions", stacked)', source)
        stacked = re.search(
            r"\.playback-sheet-status-header\.is-stacked-actions "
            r"\.playback-sheet-status-actions\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("grid-column: 1 / -1", stacked)
        self.assertIn("flex-wrap: nowrap", stacked)

    def test_absolute_seek_uses_existing_clock_and_exact_command_path(self):
        clock_source = self.script[
            self.script.index("function formatPlaybackClockSeconds") :
            self.script.index("function formatBytes")
        ]
        self.assertIn("function paintPlaybackSheetSeekPreview", clock_source)
        self.assertNotIn("setInterval", clock_source.replace(
            "window.setInterval(paintCurrentPlaybackClock, 1000)", ""
        ))
        control_source = self.script[
            self.script.index("async function sendPlayerControl") :
            self.script.index("async function sendPlayerNext")
        ]
        self.assertIn('action === "seek-absolute"', control_source)
        self.assertIn("payload.target_seconds = Math.round(numericControlValue)", control_source)
        self.assertEqual(control_source.count("apiPostExactStateCommand"), 1)
        self.assertNotIn("fetch(", control_source)
        self.assertIn('elements.playerControlPanel.addEventListener("input"', self.script)
        self.assertIn('elements.playerControlPanel.addEventListener("change"', self.script)


if __name__ == "__main__":
    unittest.main()
