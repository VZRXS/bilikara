import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class HostBuildReviewRepairTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
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

    def test_queue_and_history_are_direct_and_next_is_stage_owned(self):
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
        self.assertNotIn('id="next-button"', queue)
        self.assertNotIn('id="next-button"', history)
        self.assertIn('id="next-button"', player)
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
        self.assertNotIn("--host-tool-dock-width", self.styles)
        self.assertIn('"compact"', self.script)
        self.assertIn('"narrow"', self.script)
        self.assertIn('data-stage-controls-layout="inline"', self.styles)
        self.assertIn('id="stage-controls-toggle"', self.markup)
        self.assertIn('id="stage-control-backdrop"', self.markup)
        self.assertIn('id="stage-control-tray"', self.markup)
        self.assertIn("ResizeObserver", self.script)
        self.assertIn("measurePersistentStage", self.script)
        player_frame_rule = re.findall(
            r"\.left-column \.player-frame\s*\{([^}]*)\}", self.styles
        )[-1]
        self.assertIn("aspect-ratio: 16 / 9", player_frame_rule)
        self.assertNotIn("aspect-ratio: auto", player_frame_rule)
        self.assertIn("--stage-frame-inline-size", player_frame_rule)
        self.assertIn('data-i18n="player.controls"', self.markup)
        self.assertIn("stageControlTrayDirection", self.script)
        self.assertIn("spaceBelow", self.script)

    def test_narrow_tool_card_overlays_the_full_height_stage_from_the_bottom(self):
        narrow_rules = self.styles[self.styles.rindex("@media (max-width: 1039px)") :]
        self.assertIn("grid-template-rows: minmax(0, 1fr)", narrow_rules)
        self.assertIn("position: absolute", narrow_rules)
        self.assertIn("inset: auto 0 0", narrow_rules)
        self.assertIn("height: clamp(360px, 68%, 520px)", narrow_rules)
        self.assertIn("z-index: 20", narrow_rules)
        self.assertNotIn("grid-template-rows: clamp(190px, 34%, 280px)", narrow_rules)

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
        service_ring = re.search(r"\.service-status-ring\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("border-radius: 50%", service_ring)
        self.assertIn("border:", service_ring)
        self.assertIn("has-update", self.script)
        self.assertNotRegex(service_ring, r"(?:margin|gap|flex-basis):")
        self.assertIn(".message-surface", self.styles)
        self.assertIn("white-space: normal", self.styles)
        for language, values in self.translations["languages"].items():
            self.assertEqual(values["shell.random"], "Gatcha", language)
            self.assertNotIn("Discover", values["request.workspaceTitle"], language)
            self.assertNotIn("发现", values["request.workspaceTitle"], language)
            self.assertNotIn("見つ", values["request.workspaceTitle"], language)

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
            "Stage-owned Next",
            "independent fixed right-side tool rail",
            "stable tool width",
            "width-and-height measured Stage modes",
            "one-line icon-plus-label global toolbar",
            "platform-specific integrated window chrome",
            "Scroll-owner table",
        ):
            self.assertIn(phrase, self.design)


if __name__ == "__main__":
    unittest.main()
