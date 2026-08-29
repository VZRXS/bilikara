from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class QueueHistoryFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        cls.markup = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        cls.i18n = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )["languages"]

    def run_node(self, body: str) -> dict:
        start = self.source.index("function renderHostWorkspaceSelection")
        end = self.source.index("function closeHostWorkspaceOverlay", start)
        workspace_source = self.source[start:end]
        script = (
            """
class FakeClassList {
  constructor() { this.values = new Set(); }
  contains(name) { return this.values.has(name); }
  toggle(name, enabled) {
    if (enabled) this.values.add(name); else this.values.delete(name);
  }
}
class FakeElement {
  constructor(workspace = "", panel = false) {
    this.dataset = workspace
      ? (panel ? { hostWorkspacePanel: workspace } : { hostWorkspace: workspace })
      : {};
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.hidden = false;
    this.inert = false;
    this.tabIndex = -1;
    this.scrollTop = 0;
    this.focused = false;
    this.heading = { focused: false, focus() { this.focused = true; } };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focused = true; }
  querySelector() { return this.heading; }
}
const workspaces = ["queue", "history", "request", "random", "users"];
const buttons = workspaces.map((workspace) => new FakeElement(workspace));
const panels = workspaces.map((workspace) => new FakeElement(workspace, true));
const queueButton = buttons[0];
const historyButton = buttons[1];
const elements = {
  appShell: new FakeElement(),
  hostWorkspaceRegion: new FakeElement(),
  hostWorkspaceButtons: buttons,
  hostWorkspacePanels: panels,
  hostWorkspaceBackdrop: new FakeElement(),
  playlist: new FakeElement(),
  historyList: new FakeElement(),
};
const state = {
  activeHostWorkspace: "queue",
  focusedHostWorkspace: "queue",
  hostWorkspaceOverlayOpen: false,
  hostWorkspaceScrollPositions: {},
};
let closeCalls = 0;
let loadCalls = 0;
function closeOpenMenus() { closeCalls += 1; }
function loadPlayedSessions() { loadCalls += 1; return Promise.resolve(true); }
function closeRequestDetailForNavigation() {}
function rememberRequestScrollPosition() {}
function syncRequestSubviewSelection() {}
function restoreRequestScrollPosition() {}
"""
            + workspace_source
            + "\n"
            + body
        )
        completed = subprocess.run(
            [self.node, "-"],
            input=script,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_direct_workspaces_are_stable_accessible_and_preserve_scroll(self):
        result = self.run_node(
            """
elements.playlist.scrollTop = 91;
elements.historyList.scrollTop = 173;
const queueNode = panels[0];
const historyNode = panels[1];
renderHostWorkspaceSelection();
const initial = {
  queueSelected: queueButton.getAttribute("aria-selected"),
  historySelected: historyButton.getAttribute("aria-selected"),
  queueHidden: panels[0].hidden,
  historyHidden: panels[1].hidden,
  historyInert: panels[1].inert,
};
activateHostWorkspace("history", { inputOrigin: "pointer" });
const history = {
  queueSelected: queueButton.getAttribute("aria-selected"),
  historySelected: historyButton.getAttribute("aria-selected"),
  queueHidden: panels[0].hidden,
  queueInert: panels[0].inert,
  historyHidden: panels[1].hidden,
  focused: historyButton.focused,
};
activateHostWorkspace("queue", { inputOrigin: "pointer" });
console.log(JSON.stringify({
  initial,
  history,
  stableNodes: queueNode === panels[0] && historyNode === panels[1],
  scroll: [elements.playlist.scrollTop, elements.historyList.scrollTop],
  closeCalls,
  loadCalls,
}));
"""
        )
        self.assertEqual(
            result["initial"],
            {
                "queueSelected": "true",
                "historySelected": "false",
                "queueHidden": False,
                "historyHidden": True,
                "historyInert": True,
            },
        )
        self.assertEqual(
            result["history"],
            {
                "queueSelected": "false",
                "historySelected": "true",
                "queueHidden": True,
                "queueInert": True,
                "historyHidden": False,
                "focused": True,
            },
        )
        self.assertTrue(result["stableNodes"])
        self.assertEqual(result["scroll"], [91, 173])
        self.assertEqual(result["closeCalls"], 2)
        self.assertEqual(result["loadCalls"], 1)

    def test_rail_keyboard_wraps_and_supports_home_end(self):
        result = self.run_node(
            """
function key(target, value) {
  handleHostWorkspaceRailKeydown({
    currentTarget: target,
    key: value,
    preventDefault() {},
  });
  return state.focusedHostWorkspace;
}
const sequence = [
  key(queueButton, "ArrowUp"),
  key(buttons[4], "ArrowDown"),
  key(queueButton, "End"),
  key(buttons[4], "Home"),
];
console.log(JSON.stringify({ sequence }));
"""
        )
        self.assertEqual(result["sequence"], ["users", "queue", "users", "queue"])

    def test_markup_places_actions_on_their_final_owners(self):
        player_panel = self.markup[
            self.markup.index('<section class="player-panel">') : self.markup.index(
                '<div class="player-frame" id="player-frame">'
            )
        ]
        request_workspace = self.markup[
            self.markup.index('id="host-workspace-request"') : self.markup.index(
                'id="session-users-panel"'
            )
        ]
        queue_workspace = self.markup[
            self.markup.index('id="host-workspace-queue"') : self.markup.index(
                "</aside>", self.markup.index('id="host-workspace-queue"')
            )
        ]

        self.assertEqual(self.markup.count('id="next-button"'), 1)
        self.assertIn('id="next-button"', player_panel)
        self.assertNotIn('id="next-button"', queue_workspace)
        self.assertEqual(self.markup.count('id="resort-playlist-button"'), 1)
        self.assertIn('id="resort-playlist-button"', queue_workspace)
        self.assertNotIn('id="resort-playlist-button"', request_workspace)
        self.assertNotIn('id="queue-view-tabs"', queue_workspace)
        self.assertNotIn('data-list-view=', self.markup)
        self.assertEqual(self.markup.count('data-host-workspace="history"'), 1)
        self.assertEqual(self.markup.count('data-host-workspace-panel="history"'), 1)
        self.assertNotIn('id="history-toggle-button"', self.markup)

    def test_old_flip_and_manual_wheel_seam_are_removed(self):
        self.assertNotIn("listFlip", self.source)
        self.assertNotIn("syncListStageView", self.source)
        self.assertNotIn('elements.listStage.addEventListener("wheel"', self.source)
        self.assertNotIn("list-stage-inner", self.markup)
        self.assertNotIn("list-face", self.markup)

        list_css = self.styles[
            self.styles.index(".list-stage {") : self.styles.index(
                ".queue-card-head h2", self.styles.index(".list-stage {")
            )
        ]
        self.assertNotIn("perspective", list_css)
        self.assertNotIn("rotateY", list_css)
        self.assertNotIn("backface-visibility", list_css)
        self.assertIn("overflow: hidden", list_css)
        self.assertIn("grid-template-rows: auto minmax(0, 1fr)", list_css)

        list_scroll_css = self.styles[
            self.styles.index(".playlist,") : self.styles.index(
                ".queue-empty", self.styles.index(".playlist,")
            )
        ]
        self.assertIn("overflow: auto", list_scroll_css)
        self.assertIn("overscroll-behavior: contain", list_scroll_css)

    def test_all_direct_tools_share_one_width_per_shell_state(self):
        self.assertNotIn("--host-workspace-width", self.styles)
        self.assertNotIn("data-request-subview", self.styles)
        self.assertIn("--host-tool-card-width: 536px", self.styles)
        self.assertIn("--host-tool-card-width: 500px", self.styles)
        self.assertIn("--host-rail-width", self.styles)

    def test_reorder_actions_use_one_confirmed_exact_index_command(self):
        self.assertEqual(self.markup.count('data-action="move-up"'), 1)
        self.assertEqual(self.markup.count('data-action="move-down"'), 1)
        self.assertIn('data-i18n-aria-label="common.moveUp"', self.markup)
        self.assertIn('data-i18n-aria-label="common.moveDown"', self.markup)
        self.assertEqual(
            self.source.count('apiPostStateSnapshot("/api/playlist/reorder"'), 1
        )
        self.assertIn('moveUpButton.disabled = index === 0', self.source)
        self.assertIn(
            'moveDownButton.disabled = index === playlist.length - 1', self.source
        )
        move_action_start = self.source.index(
            'if (button.dataset.action === "move-up"'
        )
        move_action_end = self.source.index(
            'if (button.dataset.action === "remove")', move_action_start
        )
        self.assertIn("targetIndex,", self.source[move_action_start:move_action_end])
        self.assertIn('if (accepted) {', self.source)
        self.assertIn('focusPlaylistItemMenuTrigger(intent.focusItemId)', self.source)
        self.assertIn('elements.confirmCancel.focus({ preventScroll: true })', self.source)

    def test_escape_uses_one_authoritative_layer_before_row_menus(self):
        self.assertEqual(self.markup.count('aria-haspopup="menu" aria-expanded="false"'), 2)
        self.assertEqual(self.markup.count('class="song-actions menu-content hidden" role="menu"'), 1)
        self.assertEqual(self.markup.count('class="history-actions menu-content hidden" role="menu"'), 1)
        escape_start = self.source.index('document.addEventListener("keydown", (event) => {')
        escape_end = self.source.index(
            'document.addEventListener("visibilitychange"', escape_start
        )
        escape_source = self.source[escape_start:escape_end]
        ordered_layers = (
            "if (state.confirmIntent)",
            "closeOrdinaryPopoverForEscape()",
            "if (state.stageControlTrayOpen)",
            'closeOpenMenus({ restoreFocus: true })',
        )
        positions = [escape_source.index(layer) for layer in ordered_layers]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('state.openRowMenuTrigger = toggle', self.source)
        self.assertIn('trigger.focus({ preventScroll: true })', self.source)

    def test_clear_copy_and_new_accessibility_labels_exist_in_every_language(self):
        expected_clear_phrases = {
            "zh": "当前正在播放的歌曲不会受影响",
            "en": "currently playing song will not be affected",
            "ja": "現在再生中の曲には影響しません",
        }
        for language, translations in self.i18n.items():
            with self.subTest(language=language):
                self.assertIn(expected_clear_phrases[language], translations["list.clearConfirm"])
                for key in (
                    "shell.history",
                    "list.scrollLabel",
                    "history.scrollLabel",
                    "list.movedPosition",
                    "common.moveUp",
                    "common.moveDown",
                ):
                    self.assertTrue(translations[key])


if __name__ == "__main__":
    unittest.main()
