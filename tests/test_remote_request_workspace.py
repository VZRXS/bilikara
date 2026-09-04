from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RemoteMarkupParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.elements: list[tuple[str, dict[str, str | None]]] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.elements.append((tag, dict(attrs)))


class RemoteRequestWorkspaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.markup = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")
        cls.host_markup = (ROOT / "static" / "index.html").read_text(
            encoding="utf-8"
        )
        cls.styles = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")
        cls.detail_styles = (ROOT / "static" / "song-detail.css").read_text(
            encoding="utf-8"
        )
        cls.script = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.i18n_text = (ROOT / "static" / "i18n.json").read_text(
            encoding="utf-8"
        )
        cls.translations = json.loads(cls.i18n_text)["languages"]
        parser = RemoteMarkupParser()
        parser.feed(cls.markup)
        cls.elements = parser.elements
        cls.by_id = {
            attrs["id"]: (tag, attrs)
            for tag, attrs in cls.elements
            if attrs.get("id")
        }

    def elements_with(self, attribute: str) -> list[dict[str, str | None]]:
        return [attrs for _, attrs in self.elements if attribute in attrs]

    def test_one_request_card_has_four_stable_top_level_tabs_and_panels(self):
        request_cards = [
            attrs
            for _, attrs in self.elements
            if {"panel", "request-panel"}.issubset(
                set((attrs.get("class") or "").split())
            )
        ]
        self.assertEqual(len(request_cards), 1)
        tabs = self.elements_with("data-remote-request-view")
        panels = self.elements_with("data-remote-request-panel")
        values = ["quick", "search", "discover", "sources"]
        self.assertEqual([tab["data-remote-request-view"] for tab in tabs], values)
        self.assertEqual([panel["data-remote-request-panel"] for panel in panels], values)
        self.assertEqual(
            [tab["aria-controls"] for tab in tabs],
            [f"remote-request-{value}-panel" for value in values],
        )
        for index, (tab, panel) in enumerate(zip(tabs, panels, strict=True)):
            self.assertEqual(tab["role"], "tab")
            self.assertEqual(panel["role"], "tabpanel")
            self.assertEqual(tab["aria-selected"], "true" if index == 0 else "false")
            self.assertEqual(tab["tabindex"], "0" if index == 0 else "-1")
            self.assertEqual("hidden" in panel, index != 0)
            self.assertEqual("inert" in panel, index != 0)
        top_rails = [
            attrs
            for _, attrs in self.elements
            if "remote-request-tabs" in (attrs.get("class") or "").split()
        ]
        self.assertEqual(len(top_rails), 1)
        self.assertEqual(top_rails[0]["role"], "tablist")

    def test_top_level_rail_is_full_width_below_the_heading(self):
        self.assertIsNotNone(re.search(
            r'<div class="panel-head remote-request-head">\s*'
            r'<div>.*?</div>\s*</div>\s*'
            r'<div class="remote-request-tabs-viewport">\s*'
            r'<div class="remote-request-tabs" role="tablist"',
            self.markup,
            re.DOTALL,
        ))
        heading_rule = re.search(
            r"\.remote-request-head\s*\{([^}]*)\}", self.styles
        )
        self.assertIsNotNone(heading_rule)
        self.assertIn("display: block", heading_rule.group(1))
        self.assertNotIn("grid-template-columns", heading_rule.group(1))

    def test_each_secondary_tablist_has_stable_direct_ownership(self):
        expected = (
            ("remote-search-mode", "remote-search-panel", ["shared", "local"]),
            (
                "remote-discover-mode",
                "remote-discover-panel",
                ["categories", "name", "artist"],
            ),
            ("remote-sources-mode", "remote-sources-panel", ["uids", "favorites"]),
        )
        for tab_suffix, panel_suffix, values in expected:
            tabs = self.elements_with(f"data-{tab_suffix}")
            panels = self.elements_with(f"data-{panel_suffix}")
            self.assertEqual([tab[f"data-{tab_suffix}"] for tab in tabs], values)
            self.assertEqual([panel[f"data-{panel_suffix}"] for panel in panels], values)
            for index, (tab, panel) in enumerate(zip(tabs, panels, strict=True)):
                self.assertEqual(tab["role"], "tab")
                self.assertEqual(panel["role"], "tabpanel")
                self.assertEqual(tab["tabindex"], "0" if index == 0 else "-1")
                self.assertEqual(tab["aria-selected"], "true" if index == 0 else "false")
                self.assertEqual("hidden" in panel, index != 0)
                self.assertEqual("inert" in panel, index != 0)

    def test_every_live_form_and_result_surface_has_one_owner(self):
        unique_ids = (
            "request-form",
            "lark-search-form",
            "lark-search-results",
            "search-form",
            "search-results",
            "remote-discover-categories-panel",
            "remote-discover-name-panel",
            "remote-discover-artist-panel",
            "sources-follow-uid-form",
            "sources-follow-grid",
            "sources-follow-results",
            "sources-favlist-pull-form",
            "favlist-grid",
            "favlist-song-results",
        )
        for element_id in unique_ids:
            self.assertEqual(self.markup.count(f'id="{element_id}"'), 1, element_id)
        ids = [attrs["id"] for _, attrs in self.elements if attrs.get("id")]
        duplicates = sorted(
            element_id for element_id, count in Counter(ids).items() if count > 1
        )
        self.assertEqual(duplicates, [])

    def test_advanced_modal_more_button_and_modal_state_are_retired(self):
        combined = (
            self.markup
            + self.styles
            + self.detail_styles
            + self.script
            + self.i18n_text
        )
        for obsolete in (
            "search-library-open",
            "search.moreBrowse",
            "search-modal",
            "remote-search-modal",
            "searchModalOpen",
            "searchModalView",
            "searchModalCloseTimer",
            "modalFollow",
            "modalFavlist",
            "modalBrowse",
            "search-modal-other-view",
            "remote-search-modal-open",
        ):
            self.assertNotIn(obsolete, combined)

    def test_stage_one_and_surrounding_remote_cards_remain_direct(self):
        for form_id in ("request-form", "lark-search-form", "search-form"):
            self.assertEqual(self.markup.count(f'id="{form_id}"'), 1)
        self.assertNotIn('id="form-message"', self.markup)
        self.assertEqual(self.markup.count('class="panel now-playing-panel"'), 1)
        self.assertEqual(self.markup.count('class="panel queue-panel"'), 1)
        self.assertEqual(self.markup.count('class="panel gatcha-panel"'), 1)
        for stable_id in (
            "remote-header",
            "current-title",
            "queue-view-button",
            "history-view-button",
            "queue-list",
            "history-list",
            "gatcha-button",
            "refresh-gatcha-cache-button",
        ):
            self.assertEqual(self.markup.count(f'id="{stable_id}"'), 1)
        self.assertEqual(self.markup.count('id="sources-follow-uid-form"'), 1)
        for retired_gatcha_source_control in (
            "gatcha-uid-toggle",
            "gatcha-uid-view",
            "gatcha-uid-form",
            "gatcha-uid-input",
            "add-gatcha-uid-button",
            "pull-gatcha-favlist-button",
        ):
            self.assertNotIn(retired_gatcha_source_control, self.markup)
        sources_panel = self.markup[
            self.markup.index('id="remote-request-sources-panel"') : self.markup.index(
                'class="panel queue-panel"'
            )
        ]
        self.assertIn('id="refresh-gatcha-cache-button"', sources_panel)
        self.assertNotIn("setupRemoteFlipStages", self.script)
        self.assertNotIn(".gatcha-stage", self.styles)

    def test_shared_i18n_keys_drive_all_tabs_in_three_languages(self):
        keys = (
            "request.quickTab",
            "request.searchTab",
            "request.discoverTab",
            "request.sourcesTab",
            "search.sharedCatalog",
            "search.localLibrary",
            "discover.categories",
            "discover.name",
            "discover.artist",
            "discover.modeSelector",
            "sources.ownerList",
            "sources.favorites",
            "sources.modeSelector",
        )
        for language in ("zh", "en", "ja"):
            for key in keys:
                self.assertTrue(self.translations[language][key], (language, key))
        aria_only = {"discover.modeSelector", "sources.modeSelector"}
        for key in keys:
            attribute = "data-i18n-aria-label" if key in aria_only else "data-i18n"
            self.assertIn(f'{attribute}="{key}"', self.markup)
        for key in (
            "request.quickTab",
            "request.searchTab",
            "request.discoverTab",
            "request.sourcesTab",
        ):
            self.assertIn(f'data-i18n="{key}"', self.host_markup)

    def test_scrollable_rail_and_natural_document_height_contract(self):
        viewport_rule = re.search(
            r"\.remote-request-tabs-viewport\s*\{([^}]*)\}", self.styles
        )
        strip_rule = re.search(r"\.remote-request-tabs\s*\{([^}]*)\}", self.styles)
        tab_rule = re.search(r"\.remote-request-tab\s*\{([^}]*)\}", self.styles)
        self.assertIsNotNone(viewport_rule)
        self.assertIsNotNone(strip_rule)
        self.assertIsNotNone(tab_rule)
        for declaration in (
            "width: 100%",
            "overflow-x: auto",
            "overflow-y: hidden",
            "overscroll-behavior-inline: contain",
            "scrollbar-width: none",
            "touch-action: pan-x pan-y",
        ):
            self.assertIn(declaration, viewport_rule.group(1))
        for declaration in (
            "width: max-content",
            "min-width: 100%",
            "display: flex",
            "flex-wrap: nowrap",
        ):
            self.assertIn(declaration, strip_rule.group(1))
        self.assertIn("flex: 1 0 auto", tab_rule.group(1))
        self.assertIn("white-space: nowrap", tab_rule.group(1))
        self.assertIn("min-height: 48px", self.styles)
        self.assertIn(".remote-request-tabs-viewport::-webkit-scrollbar", self.styles)
        result_rule = re.search(
            r"\.remote-search-mode-panel > \.search-results,.*?\{([^}]*)\}",
            self.styles,
            re.DOTALL,
        )
        self.assertIsNotNone(result_rule)
        self.assertIn("max-height: none", result_rule.group(1))
        self.assertIn("overflow: visible", result_rule.group(1))
        self.assertNotIn("height: 100dvh", self.styles)
        self.assertNotIn("--remote-search-stage-height", self.styles)
        self.assertNotIn("remote-search-stage", self.styles + self.script)

    def test_remote_controls_share_mobile_geometry_with_distinct_tab_selection(self):
        root_rule = re.search(r":root\s*\{([^}]*)\}", self.styles)
        tabs_rule = re.search(
            r"\.remote-request-tab,\s*"
            r"\.remote-search-mode-tab,\s*"
            r"\.remote-discover-mode-tab,\s*"
            r"\.remote-sources-mode-tab,\s*"
            r"\.toggle-button\s*\{([^}]*)\}",
            self.styles,
        )
        self.assertIsNotNone(root_rule)
        self.assertIsNotNone(tabs_rule)
        for declaration in (
            "--remote-segmented-control-font-size: 16px",
            "--remote-form-control-height: 48px",
            "--remote-form-control-radius: 16px",
            "--remote-peer-action-height: 44px",
            "--remote-peer-action-font-size: 16px",
            "--remote-peer-action-radius: 14px",
            "--remote-segmented-control-active-bg: rgba(255, 255, 255, 0.95)",
            "--remote-segmented-control-active-color: var(--accent-deep)",
        ):
            self.assertIn(declaration, root_rule.group(1))
        self.assertNotIn(':root[lang="en"]', self.styles)
        self.assertIn(
            "font-size: var(--remote-segmented-control-font-size)",
            tabs_rule.group(1),
        )
        self.assertIn(
            "border-radius: var(--remote-form-control-radius)",
            tabs_rule.group(1),
        )

        for selector in (
            ".request-form :is(.primary-button, .secondary-button, .ghost-button)",
            ".history-export-row :is(.primary-button, .secondary-button, .ghost-button)",
            ".tag-browser-search input",
            ".tag-browser-search .primary-button",
        ):
            start = self.styles.index(selector)
            declarations = self.styles[start : self.styles.index("}", start)]
            self.assertIn("var(--remote-form-control-", declarations)

        for selector in (".queue-header-action", ".gatcha-pool-config-toggle"):
            start = self.styles.index(selector)
            declarations = self.styles[start : self.styles.index("}", start)]
            self.assertIn("var(--remote-peer-action-height)", declarations)
            self.assertIn("var(--remote-peer-action-radius)", declarations)

        source_refresh_start = self.styles.index(".source-refresh-button")
        source_refresh_rule = self.styles[
            source_refresh_start : self.styles.index("}", source_refresh_start)
        ]
        self.assertIn("var(--remote-form-control-height)", source_refresh_rule)
        self.assertIn("var(--remote-form-control-radius)", source_refresh_rule)

        dark_rules = re.findall(
            r':root\[data-theme="dark"\]\s*\{([^}]*)\}', self.styles
        )
        self.assertEqual(len(dark_rules), 1)
        self.assertIn(
            "--remote-segmented-control-active-bg: rgba(246, 241, 235, 0.15)",
            dark_rules[0],
        )
        self.assertIn(
            "--remote-segmented-control-active-color: var(--accent)",
            dark_rules[0],
        )

        blue_rules = re.findall(
            r':root\[data-theme="blue"\]\s*\{([^}]*)\}', self.styles
        )
        self.assertEqual(len(blue_rules), 2)
        self.assertIn(
            "--remote-segmented-control-active-bg: rgba(56, 189, 248, 0.18)",
            blue_rules[0],
        )
        self.assertIn(
            "--remote-segmented-control-active-bg: rgba(0, 210, 255, 0.18)",
            blue_rules[1],
        )
        for declarations in blue_rules:
            self.assertIn(
                "--remote-segmented-control-active-color: var(--ink)", declarations
            )
            self.assertNotIn(
                "--remote-segmented-control-active-bg: var(--remote-primary-button",
                declarations,
            )
            self.assertNotIn(
                "--remote-segmented-control-active-color: var(--remote-primary-button",
                declarations,
            )

    def test_no_request_content_swipe_or_generic_router_was_added(self):
        controller = self.script[
            self.script.index("function normalizeRemoteRequestView") :
            self.script.index("function hydrateLocalPreferences")
        ]
        for forbidden in (
            "touchstart",
            "touchmove",
            "touchend",
            "pointerdown",
            "pointermove",
            "translateX",
            "swipe",
            "carousel",
        ):
            self.assertNotIn(forbidden, controller)
        self.assertNotRegex(
            self.script,
            r"(?:requestPanel|remoteRequestDiscoverPanel).*addEventListener\(\"touch",
        )
        self.assertNotIn("class RemoteRouter", self.script)
        self.assertNotIn("localStorage", controller)

    def test_data_views_keep_independent_state_and_stale_response_guards(self):
        self.assertIn('remoteDiscoverMode: "categories"', self.script)
        self.assertIn('remoteSourcesMode: "uids"', self.script)
        self.assertIn("d1BrowseModes: {", self.script)
        self.assertIn('name: { letter: "", tag: ""', self.script)
        self.assertIn('artist: { letter: "", tag: ""', self.script)
        for retired in (
            "d1BrowseKind:",
            "d1BrowseLetter:",
            "d1BrowseTag:",
            "d1BrowseData:",
        ):
            self.assertNotIn(retired, self.script)
        for guard in (
            "if (mode.seq !== searchSeq)",
            "if (state.categoryBrowseSeq !== searchSeq)",
            "if (state.followBrowseSeq !== seq)",
            "if (state.favlistBrowseSeq !== seq)",
        ):
            self.assertIn(guard, self.script)
        for owner in (
            "shared",
            "local",
            "categories",
            "name",
            "artist",
            "uids",
            "favorites",
        ):
            self.assertRegex(
                self.script,
                rf"\b{owner}: \{{ selectedKey: \"\", focusElement: null \}}",
            )
        self.assertIn("container: elements.requestPanel", self.script)
        self.assertIn("resolveReturnFocus: resolveRequestDetailReturnFocus", self.script)

    def test_tab_controller_keeps_nodes_state_focus_and_networks_independent(self):
        controller = self.script[
            self.script.index("function normalizeRemoteRequestView") :
            self.script.index("function hydrateLocalPreferences")
        ]
        harness = f"""
let fetchCalls = 0;
let sourceLoads = [];
let activeElement = "sentinel";
const window = {{ matchMedia() {{ return {{ matches: false }}; }} }};
let searchDetailController = null;
function fetch() {{ fetchCalls += 1; }}
function renderCategoryBrowseView() {{}}
function renderD1BrowseView() {{}}
function renderSourcesFollowBrowse() {{}}
function renderFavlistBrowse() {{}}
function loadFollowBrowse() {{ sourceLoads.push("uids"); }}
function loadFavlistBrowse() {{ sourceLoads.push("favorites"); }}
function mockNode(id, dataset = {{}}) {{
  return {{
    id, dataset, hidden: false, inert: false, tabIndex: 0, attributes: {{}},
    isConnected: true, scrollCalls: [],
    setAttribute(name, value) {{ this.attributes[name] = String(value); }},
    focus() {{ activeElement = id; }},
    scrollIntoView(options) {{ this.scrollCalls.push(options); }},
    closest() {{ return null; }},
  }};
}}
const topValues = ["quick", "search", "discover", "sources"];
const searchValues = ["shared", "local"];
const discoverValues = ["categories", "name", "artist"];
const sourcesValues = ["uids", "favorites"];
const topTabs = topValues.map((value) => mockNode(`${{value}}-tab`, {{ remoteRequestView: value }}));
const topPanels = topValues.map((value) => mockNode(`${{value}}-panel`, {{ remoteRequestPanel: value }}));
const searchTabs = searchValues.map((value) => mockNode(`${{value}}-tab`, {{ remoteSearchMode: value }}));
const searchPanels = searchValues.map((value) => mockNode(`${{value}}-panel`, {{ remoteSearchPanel: value }}));
const discoverTabs = discoverValues.map((value) => mockNode(`${{value}}-tab`, {{ remoteDiscoverMode: value }}));
const discoverPanels = discoverValues.map((value) => mockNode(`${{value}}-panel`, {{ remoteDiscoverPanel: value }}));
const sourcesTabs = sourcesValues.map((value) => mockNode(`${{value}}-tab`, {{ remoteSourcesMode: value }}));
const sourcesPanels = sourcesValues.map((value) => mockNode(`${{value}}-panel`, {{ remoteSourcesPanel: value }}));
const requestForm = {{ value: "quick-value" }};
const sharedInput = {{ value: "shared-value" }};
const localInput = {{ value: "local-value" }};
const sharedRow = {{ id: "shared-row" }};
const localRow = {{ id: "local-row" }};
const remoteShell = mockNode("remote-shell");
const elements = {{
  remoteShell,
  remoteRequestViewButtons: topTabs,
  remoteRequestViewPanels: topPanels,
  remoteSearchModeButtons: searchTabs,
  remoteSearchModePanels: searchPanels,
  remoteDiscoverModeButtons: discoverTabs,
  remoteDiscoverModePanels: discoverPanels,
  remoteSourcesModeButtons: sourcesTabs,
  remoteSourcesModePanels: sourcesPanels,
}};
const state = {{
  remoteRequestView: "quick",
  remoteSearchMode: "shared",
  remoteDiscoverMode: "categories",
  remoteSourcesMode: "uids",
  followBrowseData: {{ owners: [] }}, followBrowseLoading: false,
  favlistBrowseData: {{ folders: [] }}, favlistBrowseLoading: false,
}};
{controller}
function selectedState(tabs, panels) {{
  return {{
    selected: tabs.map((tab) => tab.attributes["aria-selected"]),
    tabIndexes: tabs.map((tab) => tab.tabIndex),
    hidden: panels.map((panel) => panel.hidden),
    inert: panels.map((panel) => panel.inert),
  }};
}}
function key(handler, keyName, currentTarget) {{
  handler({{ key: keyName, currentTarget, preventDefault() {{}} }});
}}
syncRemoteRequestViewSelection();
const initial = selectedState(topTabs, topPanels);
activateRemoteRequestView("search");
const clickFocus = activeElement;
const searchState = selectedState(topTabs, topPanels);
const searchTrace = [];
key(handleRemoteSearchModeTabKeydown, "ArrowLeft", searchTabs[0]); searchTrace.push(state.remoteSearchMode);
key(handleRemoteSearchModeTabKeydown, "Home", searchTabs[1]); searchTrace.push(state.remoteSearchMode);
const discoverTrace = [];
for (const [keyName, tab] of [["ArrowLeft", discoverTabs[0]], ["Home", discoverTabs[2]], ["End", discoverTabs[0]], ["ArrowRight", discoverTabs[2]]]) {{
  key(handleRemoteDiscoverModeTabKeydown, keyName, tab); discoverTrace.push(state.remoteDiscoverMode);
}}
const sourcesTrace = [];
key(handleRemoteSourcesModeTabKeydown, "ArrowLeft", sourcesTabs[0]); sourcesTrace.push(state.remoteSourcesMode);
key(handleRemoteSourcesModeTabKeydown, "ArrowRight", sourcesTabs[1]); sourcesTrace.push(state.remoteSourcesMode);
const topTrace = [];
for (const [keyName, tab] of [["ArrowRight", topTabs[0]], ["ArrowLeft", topTabs[0]], ["Home", topTabs[3]], ["End", topTabs[0]]]) {{
  key(handleRemoteRequestTabKeydown, keyName, tab); topTrace.push(state.remoteRequestView);
}}
const beforeRestoration = [state.remoteRequestView, state.remoteSearchMode, state.remoteDiscoverMode, state.remoteSourcesMode];
syncRemoteRequestViewSelection();
const afterRestoration = [state.remoteRequestView, state.remoteSearchMode, state.remoteDiscoverMode, state.remoteSourcesMode];
state.favlistBrowseData = null;
activateRemoteSourcesMode("favorites");
console.log(JSON.stringify({{
  initial, searchState, clickFocus, searchTrace, discoverTrace, sourcesTrace, topTrace,
  beforeRestoration, afterRestoration, sourceLoads, fetchCalls,
  stableNodes: requestForm.value === "quick-value" && sharedInput.value === "shared-value"
    && localInput.value === "local-value" && sharedRow.id === "shared-row" && localRow.id === "local-row",
  revealed: topTabs.map((tab) => tab.scrollCalls.length),
  finalTop: selectedState(topTabs, topPanels),
  finalDiscover: selectedState(discoverTabs, discoverPanels),
  finalSources: selectedState(sourcesTabs, sourcesPanels),
}}));
"""
        completed = subprocess.run(
            [self.node, "-e", harness],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(result["initial"]["selected"], ["true", "false", "false", "false"])
        self.assertEqual(result["initial"]["tabIndexes"], [0, -1, -1, -1])
        self.assertEqual(result["initial"]["hidden"], [False, True, True, True])
        self.assertEqual(result["initial"]["inert"], [False, True, True, True])
        self.assertEqual(result["clickFocus"], "sentinel")
        self.assertEqual(result["searchState"]["hidden"], [True, False, True, True])
        self.assertEqual(result["searchTrace"], ["local", "shared"])
        self.assertEqual(result["discoverTrace"], ["artist", "categories", "artist", "categories"])
        self.assertEqual(result["sourcesTrace"], ["favorites", "uids"])
        self.assertEqual(result["topTrace"], ["search", "sources", "quick", "sources"])
        self.assertEqual(result["beforeRestoration"], result["afterRestoration"])
        self.assertEqual(result["sourceLoads"], ["favorites"])
        self.assertEqual(result["fetchCalls"], 0)
        self.assertTrue(result["stableNodes"])
        self.assertGreater(result["revealed"][3], 0)
        self.assertEqual(result["finalTop"]["tabIndexes"], [-1, -1, -1, 0])
        self.assertEqual(result["finalDiscover"]["tabIndexes"], [0, -1, -1])
        self.assertEqual(result["finalSources"]["tabIndexes"], [-1, 0])
        self.assertNotIn("fetch(", controller)

    def test_async_forms_have_one_owner_and_busy_guards(self):
        for element_name in (
            "requestForm",
            "searchForm",
            "larkSearchForm",
            "sourcesFollowUidForm",
            "sourcesFollowSearchForm",
            "sourcesFavlistPullForm",
            "favlistSearchForm",
        ):
            matches = re.findall(
                rf'elements\.{element_name}\??\.addEventListener\("submit"',
                self.script,
            )
            self.assertEqual(len(matches), 1, element_name)
        self.assertEqual(
            self.script.count('elements.remoteRequestDiscoverPanel?.addEventListener("click"'),
            1,
        )
        for control in (
            "larkSearchButton",
            "searchButton",
            "sourcesFollowSearchButton",
            "favlistSearchButton",
        ):
            self.assertRegex(self.script, rf"(?s){control}.{{0,220}}aria-busy", control)

    def test_remote_has_one_layout_and_no_retired_preference_path(self):
        combined = self.markup + self.styles + self.script
        for obsolete in (
            "layout-mode-switch",
            "data-layout-mode",
            "layout-mode-basic",
            "layout-mode-full",
            "bilikara.remote.layout.mode",
            "normalizeLayoutMode",
            "renderLayoutMode",
            "setLayoutMode",
        ):
            self.assertNotIn(obsolete, combined)


if __name__ == "__main__":
    unittest.main()
