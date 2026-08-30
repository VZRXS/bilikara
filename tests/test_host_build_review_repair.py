import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class HostBuildReviewRepairTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        cls.remote_markup = (ROOT / "static" / "remote.html").read_text(
            encoding="utf-8"
        )
        cls.styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        cls.script = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.translations = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )
        cls.design = (ROOT / "docs" / "host-shell-v0.8-design.txt").read_text(
            encoding="utf-8"
        )

    def test_right_dock_has_five_direct_icon_and_label_destinations(self):
        expected = ["queue", "history", "request", "random", "users"]
        self.assertEqual(
            re.findall(r'data-host-workspace="([^"]+)"', self.markup), expected
        )
        rail = re.search(
            r'<nav class="work-rail".*?</nav>', self.markup, re.DOTALL
        ).group(0)
        self.assertIn('class="work-rail-icon"', rail)
        self.assertEqual(rail.count("<svg"), 5)
        self.assertRegex(
            self.markup,
            r'(?s)id="host-workspace-history".*?</aside>\s*</section>\s*</section>\s*'
            r'<nav class="work-rail"',
        )
        self.assertIn(".layout > .work-rail", self.styles)

    def test_queue_and_history_are_direct_and_next_is_queue_current_owned(self):
        self.assertEqual(self.markup.count('id="next-button"'), 1)
        queue = re.search(
            r'<aside[^>]+id="host-workspace-queue".*?</aside>',
            self.markup,
            re.DOTALL,
        ).group(0)
        history = re.search(
            r'<aside[^>]+id="host-workspace-history".*?</aside>',
            self.markup,
            re.DOTALL,
        ).group(0)
        player = re.search(
            r'<section class="player-panel">.*?</section>\s*</section>',
            self.markup,
            re.DOTALL,
        ).group(0)
        current = re.search(
            r'<section class="queue-current[^>]*>.*?</section>',
            queue,
            re.DOTALL,
        ).group(0)
        self.assertIn('id="next-button"', current)
        self.assertNotIn('id="next-button"', history)
        self.assertNotIn('id="next-button"', player)
        self.assertIn("queue-current-next", current)
        self.assertNotIn("data-list-view", self.markup)
        self.assertNotIn("listView:", self.script)
        self.assertNotIn("activateListSubview", self.script)
        self.assertNotIn("syncListSubview", self.script)
        self.assertIn('data-host-workspace-panel="history"', history)
        self.assertIn('data-i18n="common.clear">清空</button>', queue)
        self.assertIn('data-i18n="common.clear">清空</button>', history)

    def test_shell_uses_one_width_per_state_and_measured_stage_modes(self):
        self.assertNotRegex(
            self.styles,
            r'\[data-active-workspace="(?:queue|history|request|random|users)"\]\s*\{[^}]*--host-',
        )
        self.assertNotIn("data-request-subview", self.styles)
        self.assertIn("--host-tool-card-width", self.styles)
        self.assertIn("--host-tool-card-width: minmax(380px, 1fr)", self.styles)
        self.assertIn("grid-template-columns: minmax(0, 1.82fr) var(--host-tool-card-width)", self.styles)
        self.assertNotIn("--host-tool-dock-width", self.styles)
        self.assertIn('"compact"', self.script)
        self.assertIn('"narrow"', self.script)
        self.assertIn('data-stage-controls-layout="inline"', self.styles)
        self.assertIn('id="stage-controls-toggle"', self.markup)
        self.assertIn('id="stage-control-backdrop"', self.markup)
        self.assertIn('id="stage-control-tray"', self.markup)
        self.assertIn("ResizeObserver", self.script)
        self.assertIn("measurePersistentStage", self.script)
        self.assertNotIn("innerWidth >= 760", self.script)
        self.assertIn('layout: "inline"', self.script)
        self.assertIn("contentFits: controlsStayOnOneRow && panelColumnsStayAligned && labelledButtonsFit", self.script)
        self.assertIn("inlineTraySize.contentFits", self.script)
        player_frame_rule = re.findall(
            r"\.left-column \.player-frame\s*\{([^}]*)\}", self.styles
        )[-1]
        self.assertIn("aspect-ratio: 16 / 9", player_frame_rule)
        self.assertNotIn("aspect-ratio: auto", player_frame_rule)
        self.assertIn("--stage-frame-inline-size", player_frame_rule)
        self.assertIn('data-i18n="player.controls"', self.markup)
        self.assertIn("stageControlTrayDirection", self.script)
        self.assertIn("spaceBelow", self.script)
        inline_rules = self.styles[
            self.styles.index('.app-shell[data-stage-controls-layout="inline"] .left-column > .player-panel') :
            self.styles.index(".host-workspace-region {", self.styles.index('.app-shell[data-stage-controls-layout="inline"] .left-column > .player-panel'))
        ]
        self.assertIn(".stage-controls-toggle", inline_rules)
        self.assertIn(".stage-control-tray-head", inline_rules)
        self.assertIn("display: none", inline_rules)
        self.assertNotIn(".stage-extended-controls .av-sync-panel", inline_rules)
        self.assertIn("state.stageControlInlineCollapsed = false", self.script)

    def test_narrow_tool_card_uses_measured_resident_or_bottom_overlay_geometry(self):
        narrow_rules = self.styles[self.styles.rindex("@media (max-width: 1179px)") :]
        self.assertIn("grid-template-rows: minmax(0, 1fr)", narrow_rules)
        self.assertIn("position: absolute", narrow_rules)
        self.assertIn("inset: auto 0 0", narrow_rules)
        self.assertIn("height: clamp(360px, 68%, 520px)", narrow_rules)
        self.assertIn("z-index: 20", narrow_rules)
        self.assertIn("border-radius: 16px", narrow_rules)
        self.assertIn('[data-narrow-tool-layout="resident"]', narrow_rules)
        self.assertIn("--narrow-stage-resident-height", narrow_rules)
        self.assertIn("grid-template-rows: minmax(0, var(--narrow-stage-resident-height)) minmax(300px, 1fr)", narrow_rules)
        self.assertRegex(
            narrow_rules,
            r'(?s)\[data-narrow-tool-layout="resident"\] \.left-column\s*\{[^}]*z-index: 30;',
        )
        self.assertNotIn("grid-template-rows: clamp(190px, 34%, 280px)", narrow_rules)
        self.assertIn("state.hostWorkspaceOverlayOpen = false", self.script)
        self.assertIn("function syncNarrowToolLayout()", self.script)
        self.assertIn("minimumResidentToolHeight = 300", self.script)
        self.assertIn("inlineTrayFitsWidth && availableStageHeight >= fullStageHeight", self.script)
        self.assertIn(": compactStageHeight", self.script)
        self.assertIn(
            '[data-stage-controls-layout="popup"] .left-column > .player-panel',
            self.styles,
        )
        self.assertRegex(
            self.styles,
            r'(?s)\[data-stage-controls-layout="popup"\] \.left-column > \.player-panel\s*\{[^}]*align-content: start;',
        )
        self.assertIn('dataset.narrowToolLayout = "overlay"', self.script)
        self.assertIn('dataset.narrowToolLayout = "resident"', self.script)

    def test_service_and_playback_controls_use_distinct_reviewed_icons(self):
        remote_control_path = (
            "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2z"
            "M7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"
        )
        self.assertIn(remote_control_path, self.remote_markup)
        self.assertIn(remote_control_path, self.markup)
        service = re.search(
            r'id="cache-settings-toggle".*?</button>', self.markup, re.DOTALL
        ).group(0)
        self.assertIn("M12.22 2h-.44", service)
        self.assertIn('<circle cx="12" cy="12" r="3">', service)
        self.assertNotIn(remote_control_path, service)
        stage_button = next(
            rule
            for rule in re.findall(
                r"\.stage-controls-toggle\s*\{([^}]*)\}", self.styles
            )
            if "background:" in rule
        )
        self.assertIn("background: var(--accent)", stage_button)
        self.assertIn("color: var(--on-accent)", stage_button)

    def test_queue_and_history_actions_share_the_title_row(self):
        card_head_rules = re.findall(
            r"\.host-workspace-region \.queue-card-head\s*\{([^}]*)\}",
            self.styles,
        )[-1]
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto", card_head_rules)
        self.assertIn("grid-template-rows: auto auto", card_head_rules)
        toolbar_rules = re.findall(
            r"\.host-workspace-region \.queue-toolbar\s*\{([^}]*)\}",
            self.styles,
        )[-1]
        self.assertIn("grid-column: 2", toolbar_rules)
        self.assertIn("grid-row: 2", toolbar_rules)

    def test_toolbar_badge_messages_and_product_copy_match_review(self):
        self.assertIn('class="global-action-icon"', self.markup)
        self.assertGreaterEqual(self.markup.count('class="global-action-icon"'), 4)
        self.assertRegex(
            self.styles,
            r'\.topbar \.control-label[^}]*font-size:\s*(?:13|14|15|16)px',
        )
        service_wrap = re.search(r"\.service-status-wrap\s*\{([^}]*)\}", self.styles).group(1)
        self.assertNotIn("border:", service_wrap)
        self.assertNotIn("service-status-ring", self.markup)
        self.assertIn("--update-available-dot: var(--accent)", self.styles)
        update_dot = re.search(r"\.app-update-indicator\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("var(--update-available-dot)", update_dot)
        self.assertNotIn('setClassToggle(elements.serviceUpdateIndicator, "has-update"', self.script)
        topbar_rule = re.findall(r"(?m)^\.topbar\s*\{([^}]*)\}", self.styles)[-1]
        self.assertIn("border-bottom: 0", topbar_rule)
        self.assertIn("background: transparent", topbar_rule)
        self.assertIn(".message-surface", self.styles)
        self.assertIn("white-space: normal", self.styles)
        for language, values in self.translations["languages"].items():
            expected_gatcha = "试试运气" if language == "zh" else "Gatcha"
            self.assertEqual(values["shell.random"], expected_gatcha, language)
            self.assertEqual(values["gatcha.title"], expected_gatcha, language)
            self.assertNotIn("Discover", values["request.workspaceTitle"], language)
            self.assertNotIn("发现", values["request.workspaceTitle"], language)
            self.assertNotIn("見つ", values["request.workspaceTitle"], language)

    def test_playback_controls_share_one_divided_surface_and_gatcha_uses_dice_svg(self):
        self.assertIn(
            ".stage-extended-controls > .av-sync-panel + .volume-panel",
            self.styles,
        )
        combined_surface = re.findall(
            r"\.stage-extended-controls\s*\{([^}]*)\}", self.styles
        )[-1]
        self.assertIn("gap: 0", combined_surface)
        self.assertIn("border: 1px solid var(--line)", combined_surface)
        control_rows = re.search(
            r"\.stage-extended-controls > \.av-sync-panel,\s*"
            r"\.stage-extended-controls > \.volume-panel\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("grid-template-columns: max-content minmax(0, 1fr)", control_rows)
        self.assertIn("border: 0", control_rows)
        aligned_controls = re.search(
            r"\.stage-extended-controls \.av-sync-controls,\s*"
            r"\.stage-extended-controls \.volume-controls\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("width: max-content", aligned_controls)
        self.assertIn("justify-self: end", aligned_controls)
        inline_tray = re.search(
            r'\.app-shell\[data-stage-controls-layout="inline"\] '
            r"\.stage-control-tray\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("z-index: 7", inline_tray)
        gatcha_rail = re.search(
            r'id="work-rail-random"(?P<body>.*?)</button>', self.markup, re.S
        ).group("body")
        self.assertIn("<rect", gatcha_rail)
        self.assertGreaterEqual(gatcha_rail.count("<circle"), 5)

    def test_platform_specific_tauri_chrome_is_explicit(self):
        windows_path = ROOT / "src-tauri" / "tauri.windows.conf.json"
        self.assertTrue(windows_path.exists())
        windows = json.loads(windows_path.read_text(encoding="utf-8"))
        window = windows["app"]["windows"][0]
        self.assertFalse(window["decorations"])
        main_capability = json.loads(
            (ROOT / "src-tauri" / "capabilities" / "main.json").read_text(
                encoding="utf-8"
            )
        )
        for permission in (
            "core:window:allow-close",
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-start-dragging",
        ):
            self.assertIn(permission, main_capability["permissions"])
        macos = json.loads(
            (ROOT / "src-tauri" / "tauri.macos.conf.json").read_text(
                encoding="utf-8"
            )
        )["app"]["windows"][0]
        self.assertEqual(macos["titleBarStyle"], "Overlay")
        self.assertTrue(macos["hiddenTitle"])
        self.assertIn('id="window-controls"', self.markup)
        self.assertIn("initializeWindowChrome", self.script)

    def test_design_records_corrected_contract_and_scroll_owner_table(self):
        for phrase in (
            "Queue and History are direct destinations",
            "Queue's Now Playing card",
            "independent fixed right-side tool rail",
            "same width at a fixed viewport",
            "width-and-height measured Stage modes",
            "one-line icon-plus-label global toolbar",
            "platform-specific integrated window chrome",
            "Scroll-owner table",
        ):
            self.assertIn(phrase, self.design)


if __name__ == "__main__":
    unittest.main()
