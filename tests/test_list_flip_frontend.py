from __future__ import annotations

import json
import re
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
        self.assertNotIn('id="next-button"', player_panel)
        self.assertIn('id="next-button"', queue_workspace)
        self.assertIn('class="next-button queue-current-next"', queue_workspace)
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
        self.assertIn("function syncQueueScrollOwnership()", self.source)
        self.assertIn('playlist.classList.toggle("is-scrollable", scrollable)', self.source)
        self.assertIn('playlist.classList.toggle("is-content-fit", !scrollable)', self.source)
        self.assertRegex(
            self.styles,
            r"(?s)\.host-workspace-region \.playlist\s*\{[^}]*overflow-y: hidden;[^}]*scrollbar-gutter: auto;",
        )
        self.assertRegex(
            self.styles,
            r"(?s)\.host-workspace-region \.playlist\.is-scrollable\s*\{[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;",
        )

    def test_request_discover_uses_one_direct_accessible_workspace(self):
        self.assertEqual(self.markup.count('id="host-workspace-request"'), 1)
        self.assertEqual(self.markup.count('data-request-view="quick"'), 1)
        self.assertEqual(self.markup.count('data-request-view="search"'), 1)
        self.assertEqual(self.markup.count('data-request-view="discover"'), 1)
        self.assertEqual(self.markup.count('data-request-view="sources"'), 1)

        request_workspace = self.markup[
            self.markup.index('id="host-workspace-request"') : self.markup.index(
                'id="session-users-panel"'
            )
        ]
        self.assertIn('role="tablist"', request_workspace)
        search_tab = request_workspace[
            request_workspace.index('data-request-view="search"') : request_workspace.index(
                "</button>", request_workspace.index('data-request-view="search"')
            )
        ]
        self.assertIn('aria-selected="true"', search_tab)
        self.assertIn('tabindex="0"', search_tab)
        self.assertIn('data-request-panel="search"', request_workspace)
        self.assertNotIn('data-request-panel="search" hidden', request_workspace)
        for panel in ("quick", "discover", "sources"):
            panel_markup = request_workspace[
                request_workspace.index(f'data-request-panel="{panel}"') : request_workspace.index(
                    ">", request_workspace.index(f'data-request-panel="{panel}"')
                )
            ]
            self.assertIn("hidden", panel_markup)
            self.assertIn("inert", panel_markup)

        for mode in ("shared", "local"):
            self.assertEqual(request_workspace.count(f'data-search-mode="{mode}"'), 1)
        for mode in ("categories", "name", "artist"):
            self.assertEqual(request_workspace.count(f'data-discover-mode="{mode}"'), 1)
        for mode in ("uids", "favorites"):
            self.assertEqual(request_workspace.count(f'data-sources-mode="{mode}"'), 1)
        source_uid_tab = request_workspace[
            request_workspace.index('data-sources-mode="uids"') : request_workspace.index(
                "</button>", request_workspace.index('data-sources-mode="uids"')
            )
        ]
        self.assertIn('data-i18n="sources.addUid">添加 UID', source_uid_tab)
        self.assertNotIn('data-i18n="sources.addedUids"', source_uid_tab)

        expected_labels = {
            "request.quickTab": {"zh": "快速点歌", "en": "Quick Request", "ja": "クイック予約"},
            "request.searchTab": {"zh": "搜索", "en": "Search", "ja": "検索"},
            "request.discoverTab": {"zh": "发现", "en": "Discover", "ja": "見つける"},
            "request.sourcesTab": {"zh": "来源", "en": "Sources", "ja": "ソース"},
            "search.sharedCatalog": {"zh": "共享曲库", "en": "Shared catalog", "ja": "共有カタログ"},
            "search.localLibrary": {"zh": "本地曲库", "en": "Local library", "ja": "ローカルライブラリ"},
            "sources.addUid": {"zh": "添加 UID", "en": "Add UID", "ja": "UID を追加"},
            "sources.favorites": {"zh": "收藏夹", "en": "Favorites", "ja": "お気に入り"},
        }
        for key, labels in expected_labels.items():
            for language, expected in labels.items():
                with self.subTest(key=key, language=language):
                    self.assertEqual(self.i18n[language][key], expected)

    def test_all_tools_and_request_subviews_share_one_width_per_shell_state(self):
        self.assertNotIn("--host-workspace-width", self.styles)
        self.assertNotIn("data-request-subview", self.styles)
        self.assertIn("--host-tool-card-width: minmax(380px, 1fr)", self.styles)
        self.assertNotIn("--host-tool-card-width: 500px", self.styles)
        self.assertIn("--host-rail-width", self.styles)

    def test_request_removes_host_search_flip_modal_and_source_duplicates(self):
        for retired_markup in (
            'id="search-stage"',
            'id="search-stage-inner"',
            'id="search-expand-button"',
            'id="search-modal"',
            'id="lark-search-hitbox-form"',
        ):
            self.assertNotIn(retired_markup, self.markup)
        for retired_source in (
            "searchStageView",
            "searchStageAngle",
            "searchFlipTimer",
            "searchFlipFrame",
            "syncSearchStageView",
            "openExpandedSearchModal",
            "closeExpandedSearchModal",
            "searchModalPlaceholder.appendChild",
        ):
            self.assertNotIn(retired_source, self.source)
        for retired_css in (
            ".search-stage",
            ".search-face-front",
            ".search-modal-card",
        ):
            self.assertNotIn(retired_css, self.styles)

        self.assertEqual(self.markup.count('id="modal-follow-uid-form"'), 1)
        self.assertEqual(self.markup.count('id="refresh-gatcha-cache-button"'), 1)
        self.assertEqual(self.markup.count('id="modal-favlist-pull-form"'), 1)
        random_workspace = self.markup[
            self.markup.index('id="gatcha-panel"') : self.markup.index(
                'id="host-workspace-queue"'
            )
        ]
        self.assertNotIn('id="gatcha-uid-form"', random_workspace)
        self.assertNotIn('id="refresh-gatcha-cache-button"', random_workspace)
        self.assertNotIn('id="pull-gatcha-favlist-button"', random_workspace)
        self.assertEqual(random_workspace.count('id="manage-sources-button"'), 1)

    def test_gatcha_is_one_direct_state_workspace_with_local_scroll(self):
        self.assertEqual(self.markup.count('id="gatcha-panel"'), 1)
        self.assertEqual(self.markup.count('id="gatcha-pool-config-modal"'), 1)
        self.assertEqual(self.markup.count('id="manage-sources-button"'), 1)
        self.assertEqual(self.markup.count('id="gatcha-button"'), 1)
        self.assertEqual(self.markup.count('id="gatcha-retry-button"'), 1)
        self.assertEqual(self.markup.count('id="gatcha-confirm-button"'), 1)
        for view in ("idle", "drawing", "candidate", "error"):
            with self.subTest(view=view):
                self.assertEqual(self.markup.count(f'data-gatcha-view="{view}"'), 1)

        random_workspace = self.markup[
            self.markup.index('id="gatcha-panel"') : self.markup.index(
                'id="host-workspace-queue"'
            )
        ]
        self.assertIn('id="gatcha-stage"', random_workspace)
        self.assertIn('data-i18n-aria-label="gatcha.scrollLabel"', random_workspace)
        self.assertNotIn("gatcha-face", random_workspace)
        self.assertNotIn("perspective", self.styles[self.styles.index(".gatcha-panel {") :])
        self.assertNotIn("rotateY", self.styles[self.styles.index(".gatcha-panel {") :])

        random_owner_rule = re.search(
            r'\.host-workspace-region\[data-active-workspace="random"\]\s*\{([^}]*)\}',
            self.styles,
        )
        self.assertIsNotNone(random_owner_rule)
        self.assertIn("overflow: hidden", random_owner_rule.group(1))
        gatcha_body_rule = re.search(r"\.gatcha-stage\s*\{([^}]*)\}", self.styles)
        self.assertIsNotNone(gatcha_body_rule)
        self.assertIn("overflow-y: auto", gatcha_body_rule.group(1))
        self.assertIn("overscroll-behavior: contain", gatcha_body_rule.group(1))

    def test_gatcha_state_and_pool_ownership_are_narrow_and_stale_safe(self):
        for field in (
            "gatchaView",
            "gatchaDrawBusy",
            "gatchaDrawSequence",
            "gatchaDrawError",
            "gatchaScrollTop",
            "poolConfigAccepted",
            "poolConfigDraft",
            "poolConfigLoading",
            "poolConfigLoadSequence",
            "poolConfigSaveSequence",
        ):
            with self.subTest(field=field):
                self.assertIn(field, self.source)
        self.assertIn("renderGatchaWorkspace();", self.source)
        self.assertIn("state.gatchaDrawSequence !== drawSequence", self.source)
        self.assertIn("state.poolConfigLoadSequence !== loadSequence", self.source)
        self.assertIn("state.poolConfigSaveSequence !== saveSequence", self.source)

        random_workspace = self.markup[
            self.markup.index('id="gatcha-panel"') : self.markup.index(
                'id="host-workspace-queue"'
            )
        ]
        pool_sheet = self.markup[
            self.markup.index('id="gatcha-pool-config-modal"') : self.markup.index(
                'id="bilikara-secret-modal"'
            )
        ]
        for forbidden in (
            'id="modal-follow-uid-form"',
            'id="refresh-gatcha-cache-button"',
            'id="modal-favlist-pull-form"',
            "/api/gatcha/uids/add",
            "/api/gatcha/refresh",
            "/api/gatcha/favlist",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, random_workspace)
                self.assertNotIn(forbidden, pool_sheet)

    def test_sources_owns_the_only_add_uid_command_path(self):
        self.assertEqual(self.markup.count('id="modal-follow-uid-form"'), 1)
        self.assertEqual(
            len(re.findall(r"(?<!function )\baddGatchaUid\(", self.source)),
            1,
        )
        self.assertNotIn("data-rating-add-up", self.source)
        rating_render_start = self.source.index("function renderRatingPromptContent()")
        rating_open_start = self.source.index("function openRatingPrompt(", rating_render_start)
        rating_open_end = self.source.index("function maybeShowRatingPromptForProgress", rating_open_start)
        rating_handler_start = self.source.index(
            'document.addEventListener("click", async (event) => {\n'
            "  const root = state.ratingPromptElement;"
        )
        rating_handler_end = self.source.index(
            "function handleRatingFullscreenChange()", rating_handler_start
        )
        rating_source = (
            self.source[rating_render_start:rating_open_start]
            + self.source[rating_open_start:rating_open_end]
            + self.source[rating_handler_start:rating_handler_end]
        )
        for source_owner in (
            "addGatchaUid(",
            "previewGatchaUid(",
            "refreshGatchaCache(",
            "previewGatchaFavlist(",
            "fetchGatchaBrowse(",
            "fetchGatchaFavlistBrowse(",
        ):
            with self.subTest(source_owner=source_owner):
                self.assertNotIn(source_owner, rating_source)

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
            "closeHighestRequestTaskLayerForEscape()",
            "searchDetailController?.isOpen?.()",
            "closeOrdinaryPopoverForEscape()",
            "if (state.stageControlTrayOpen && !stageControlsAreInline())",
            "closeHostWorkspaceOverlay()",
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
