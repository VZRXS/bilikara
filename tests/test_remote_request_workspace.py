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
        cls.script = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.translations = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )["languages"]
        parser = RemoteMarkupParser()
        parser.feed(cls.markup)
        cls.elements = parser.elements
        cls.by_id = {
            attrs["id"]: (tag, attrs)
            for tag, attrs in cls.elements
            if attrs.get("id")
        }

    def element(self, element_id: str) -> tuple[str, dict[str, str | None]]:
        self.assertIn(element_id, self.by_id)
        return self.by_id[element_id]

    def test_one_request_card_owns_quick_shared_and_local_forms(self):
        request_cards = [
            attrs
            for _, attrs in self.elements
            if {"panel", "request-panel"}.issubset(
                set((attrs.get("class") or "").split())
            )
        ]
        self.assertEqual(len(request_cards), 1)
        self.assertNotRegex(self.markup, r'class="[^"]*\bsearch-panel\b')

        for form_id in ("request-form", "lark-search-form", "search-form"):
            self.assertEqual(self.markup.count(f'id="{form_id}"'), 1)
        self.assertNotIn("form-message", self.by_id)

        quick_tab = self.element("remote-request-quick-tab")[1]
        search_tab = self.element("remote-request-search-tab")[1]
        quick_panel = self.element("remote-request-quick-panel")[1]
        search_panel = self.element("remote-request-search-panel")[1]
        self.assertEqual(quick_tab["role"], "tab")
        self.assertEqual(quick_tab["aria-selected"], "true")
        self.assertEqual(quick_tab["tabindex"], "0")
        self.assertEqual(search_tab["aria-selected"], "false")
        self.assertEqual(search_tab["tabindex"], "-1")
        self.assertNotIn("hidden", quick_panel)
        self.assertNotIn("inert", quick_panel)
        self.assertIn("hidden", search_panel)
        self.assertIn("inert", search_panel)

        shared_tab = self.element("remote-search-shared-tab")[1]
        local_tab = self.element("remote-search-local-tab")[1]
        shared_panel = self.element("remote-search-shared-panel")[1]
        local_panel = self.element("remote-search-local-panel")[1]
        self.assertEqual(shared_tab["aria-selected"], "true")
        self.assertEqual(shared_tab["tabindex"], "0")
        self.assertEqual(local_tab["aria-selected"], "false")
        self.assertEqual(local_tab["tabindex"], "-1")
        self.assertNotIn("hidden", shared_panel)
        self.assertNotIn("inert", shared_panel)
        self.assertIn("hidden", local_panel)
        self.assertIn("inert", local_panel)

    def test_embedded_follow_and_duplicate_modal_search_are_removed(self):
        for element_id in (
            "lark-search-toggle",
            "follow-browse-toggle",
            "follow-browse-view",
            "follow-up-list-view",
            "follow-up-items-view",
            "follow-up-grid",
            "follow-song-results",
            "search-modal-search-view",
            "search-modal-lark-form",
            "search-modal-lark-query",
            "search-modal-lark-button",
            "search-modal-lark-message",
            "search-modal-lark-results",
        ):
            self.assertNotIn(element_id, self.by_id)

        advanced_targets = [
            attrs.get("data-target")
            for _, attrs in self.elements
            if "remote-search-modal-tab" in (attrs.get("class") or "").split()
        ]
        self.assertEqual(
            advanced_targets,
            ["follow", "favlist", "category", "name", "artist"],
        )
        self.assertNotIn('data-target="search"', self.markup)
        self.assertIn('searchModalView: "follow"', self.script)
        self.assertIn(
            '["follow", "favlist", "category", "name", "artist"]',
            self.script,
        )

    def test_more_browse_is_localized_and_gatcha_queue_remain_separate(self):
        more_browse = self.element("search-library-open")[1]
        self.assertEqual(more_browse["type"], "button")
        self.assertEqual(more_browse["data-i18n"], "search.moreBrowse")
        self.assertEqual(
            more_browse["data-i18n-aria-label"], "search.moreBrowse"
        )
        expected = {"zh": "更多", "en": "More", "ja": "その他"}
        for language, label in expected.items():
            self.assertEqual(
                self.translations[language]["search.moreBrowse"], label
            )

        catalog_labels = {
            "zh": ("共享曲库", "本地曲库"),
            "en": ("Shared", "Local"),
            "ja": ("共有ライブラリ", "ローカルライブラリ"),
        }
        for language, labels in catalog_labels.items():
            self.assertEqual(
                self.translations[language]["search.sharedCatalog"], labels[0]
            )
            self.assertEqual(
                self.translations[language]["search.localLibrary"], labels[1]
            )

        quick_labels = {"zh": "快速点歌", "en": "Quick", "ja": "クイック"}
        for language, label in quick_labels.items():
            self.assertEqual(
                self.translations[language]["request.quickTab"], label
            )
        self.assertEqual(self.translations["en"]["request.title"], "Request")

        for key in (
            "request.quickTab",
            "request.searchTab",
            "search.sharedCatalog",
            "search.localLibrary",
        ):
            marker = f'data-i18n="{key}"'
            self.assertIn(marker, self.markup)
            self.assertIn(marker, self.host_markup)
        self.assertEqual(
            self.translations["ja"]["search.sharedContract"],
            "共有ライブラリの結果を最大 80 件表示します",
        )
        self.assertEqual(
            self.translations["ja"]["search.sharedResultsLabel"],
            "共有ライブラリの検索結果",
        )
        for language in ("en", "ja"):
            for key in (
                "search.sharedContract",
                "search.sharedResultsLabel",
                "search.localResultsLabel",
                "discover.advanced",
            ):
                self.assertNotIn(
                    "catalog" if language == "en" else "カタログ",
                    self.translations[language][key].lower(),
                )

        self.assertEqual(self.markup.count('class="panel queue-panel"'), 1)
        self.assertEqual(self.markup.count('class="panel gatcha-panel"'), 1)
        for stable_id in (
            "queue-view-button",
            "history-view-button",
            "queue-list",
            "history-list",
            "resort-playlist-button",
        ):
            self.assertEqual(self.markup.count(f'id="{stable_id}"'), 1)

    def test_markup_has_no_duplicate_ids(self):
        ids = [attrs["id"] for _, attrs in self.elements if attrs.get("id")]
        duplicates = sorted(
            element_id for element_id, count in Counter(ids).items() if count > 1
        )
        self.assertEqual(duplicates, [])

    def test_remote_has_one_layout_and_no_retired_preference_path(self):
        self.assertNotIn("layout-mode-switch", self.markup)
        self.assertNotIn("data-layout-mode", self.markup)
        self.assertNotIn("layout-mode-basic", self.markup + self.styles + self.script)
        self.assertNotIn("layout-mode-full", self.markup + self.styles + self.script)
        self.assertNotIn("bilikara.remote.layout.mode", self.script)
        for obsolete in (
            "layoutMode",
            "normalizeLayoutMode",
            "renderLayoutMode",
            "setLayoutMode",
        ):
            self.assertNotIn(obsolete, self.script)

        for language in self.translations.values():
            for obsolete_key in (
                "top.layout",
                "layout.basic",
                "layout.full",
                "layout.basicLayout",
                "layout.fullLayout",
                "display.layoutHint",
            ):
                self.assertNotIn(obsolete_key, language)

    def test_retired_stage_css_and_state_are_absent(self):
        for obsolete in (
            "--remote-search-stage-height",
            ".remote-search-stage",
            ".remote-search-face",
            "remoteSearchStageView",
            "remoteSearchStageAngle",
            "remoteSearchFlipTimer",
            "remoteSearchFlipFrame",
            "remoteSearchPruneTimer",
            "searchModalLarkLoading",
            "searchModalLarkSeq",
        ):
            self.assertNotIn(obsolete, self.styles + self.script)

        request_view_rule = re.search(
            r"\.remote-request-view,\s*\.remote-search-mode-panel\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        search_panel_rule = re.search(
            r"\.remote-search-mode-panel\s*\{([^}]*)\}", self.styles
        ).group(1)
        for rule in (request_view_rule, search_panel_rule):
            self.assertNotRegex(rule, r"(?:min-)?height\s*:")
        natural_results = re.search(
            r"\.remote-search-mode-panel > \.search-results\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("max-height: none", natural_results)
        self.assertIn("overflow: visible", natural_results)

    def test_tab_touch_targets_and_focus_rules_are_scoped(self):
        tab_rule = re.search(
            r"\.remote-request-tab,\s*\.remote-search-mode-tab,\s*\.toggle-button\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        more_rule = re.search(
            r"\.search-more-browse\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("min-height: 48px", tab_rule)
        self.assertRegex(more_rule, r"min-height:\s*(?:4[4-9]|[5-9]\d)px")
        self.assertIn(".remote-request-tab:focus-visible", self.styles)
        self.assertIn(".remote-search-mode-tab:focus-visible", self.styles)

    def test_segmented_controls_share_queue_geometry_and_theme_tokens(self):
        shared_rail_rule = re.search(
            r"\.remote-request-tabs,\s*\.remote-search-mode-tabs,\s*\.view-toggle\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("gap: 0", shared_rail_rule)
        self.assertIn("padding: 0 4px", shared_rail_rule)
        self.assertIn(
            "background: var(--remote-segmented-control-bg)", shared_rail_rule
        )

        tab_rule = re.search(
            r"\.remote-request-tab,\s*\.remote-search-mode-tab,\s*\.toggle-button\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("border: 0 solid transparent", tab_rule)
        self.assertIn("border-block-width: 4px", tab_rule)
        self.assertIn("padding: 10px 0", tab_rule)
        self.assertIn("background-clip: padding-box", tab_rule)
        self.assertIn("border-radius: 18px", tab_rule)
        self.assertIn("display: flex", tab_rule)
        self.assertIn("align-items: center", tab_rule)
        self.assertIn("justify-content: center", tab_rule)
        self.assertIn("text-align: center", tab_rule)
        self.assertIn("font-size: 14px", tab_rule)
        self.assertIn("font-weight: 700", tab_rule)
        self.assertNotIn("--view-toggle-bg", self.styles)
        self.assertNotIn("--toggle-active-bg", self.styles)
        self.assertGreaterEqual(
            self.styles.count("--remote-segmented-control-active-bg:"), 3
        )
        active_shadows = re.findall(
            r"--remote-segmented-control-active-shadow:\s*([^;]+);",
            self.styles,
        )
        self.assertGreaterEqual(len(active_shadows), 3)
        self.assertEqual(set(active_shadows), {"none"})

    def test_button_colors_are_component_tokens_and_more_browse_uses_ghost_style(self):
        for token in (
            "--remote-primary-button-bg",
            "--remote-primary-button-color",
            "--remote-primary-button-disabled-bg",
            "--remote-secondary-button-bg",
            "--remote-secondary-button-disabled-bg",
        ):
            self.assertGreaterEqual(self.styles.count(f"{token}:"), 3)
        self.assertNotIn("--remote-more-browse-", self.styles)

        primary = re.search(
            r"(?m)^\.primary-button\s*\{([^}]*)\}", self.styles
        ).group(1)
        primary_disabled = re.search(
            r"(?m)^\.primary-button:disabled\s*\{([^}]*)\}", self.styles
        ).group(1)
        more_browse = re.search(
            r"\.remote-search-toolbar \.search-more-browse\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("var(--remote-primary-button-bg)", primary)
        self.assertIn("var(--remote-primary-button-color)", primary)
        self.assertIn("var(--remote-primary-button-disabled-bg)", primary_disabled)
        for property_name in ("background:", "color:", "border:", "font-weight:"):
            self.assertNotIn(property_name, more_browse)
        self.assertIn("ghost-button search-more-browse", self.markup)

    def test_primary_request_tabs_share_the_title_row_at_phone_width(self):
        request_head = re.search(
            r'<div class="panel-head remote-request-head">.*?'
            r'<div class="remote-request-tabs".*?</div>\s*</div>',
            self.markup,
            re.DOTALL,
        )
        self.assertIsNotNone(request_head)
        title_row = re.search(
            r"\.remote-request-head\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto", title_row)
        adaptive_tabs = re.search(
            r"\.remote-request-tabs\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("width: max-content", adaptive_tabs)
        self.assertIn("max-width: 100%", adaptive_tabs)
        self.assertIn("grid-template-columns: repeat(2, max-content)", adaptive_tabs)
        adaptive_tab = re.search(
            r"\.remote-request-tab\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("min-width: 44px", adaptive_tab)
        self.assertIn("padding-inline: 22px", adaptive_tab)
        self.assertIn("white-space: nowrap", adaptive_tab)
        narrow_rule = re.search(
            r"@media \(max-width: 350px\)\s*\{(.*?)\n\}",
            self.styles,
            re.DOTALL,
        ).group(1)
        self.assertIn(".remote-request-head", narrow_rule)
        self.assertIn("grid-template-columns: minmax(0, 1fr)", narrow_rule)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr))", narrow_rule)

    def test_quick_request_feedback_uses_toast_without_inline_surface(self):
        self.assertNotIn('id="form-message"', self.markup)
        self.assertNotIn("formMessage:", self.script)
        wrapper = self.script[
            self.script.index("function setFormMessage") :
            self.script.index("function setAppMessage")
        ]
        self.assertIn("setAppMessage(message, isError)", wrapper)
        self.assertNotIn("textContent", wrapper)

    def test_tab_controller_preserves_nodes_and_performs_no_fetch(self):
        controller = self.script[
            self.script.index("function normalizeRemoteRequestView") :
            self.script.index("function hydrateLocalPreferences")
        ]
        harness = f"""
let fetchCalls = 0;
function fetch() {{ fetchCalls += 1; }}

function mockClassList() {{
  const values = new Set();
  return {{
    toggle(name, force) {{ if (force) values.add(name); else values.delete(name); }},
    contains(name) {{ return values.has(name); }},
  }};
}}
let activeElement = "sentinel";
function mockNode(id, dataset) {{
  return {{
    id, dataset, hidden: false, inert: false, tabIndex: 0, attributes: {{}},
    classList: mockClassList(),
    setAttribute(name, value) {{ this.attributes[name] = String(value); }},
    focus(options) {{ activeElement = id; this.focusOptions = options; }},
  }};
}}
const quickTab = mockNode("quick-tab", {{ remoteRequestView: "quick" }});
const searchTab = mockNode("search-tab", {{ remoteRequestView: "search" }});
const quickPanel = mockNode("quick-panel", {{ remoteRequestPanel: "quick" }});
const searchPanel = mockNode("search-panel", {{ remoteRequestPanel: "search" }});
const sharedTab = mockNode("shared-tab", {{ remoteSearchMode: "shared" }});
const localTab = mockNode("local-tab", {{ remoteSearchMode: "local" }});
const sharedPanel = mockNode("shared-panel", {{ remoteSearchPanel: "shared" }});
const localPanel = mockNode("local-panel", {{ remoteSearchPanel: "local" }});
const requestForm = {{ id: "request-form" }};
const sharedForm = {{ id: "lark-search-form" }};
const localForm = {{ id: "search-form" }};
const sharedResults = {{ id: "lark-search-results", children: [{{ id: "shared-row" }}] }};
const localResults = {{ id: "search-results", children: [{{ id: "local-row" }}] }};
const remoteShell = mockNode("remote-shell", {{}});
const elements = {{
  remoteShell,
  remoteRequestViewButtons: [quickTab, searchTab],
  remoteRequestViewPanels: [quickPanel, searchPanel],
  remoteSearchModeButtons: [sharedTab, localTab],
  remoteSearchModePanels: [sharedPanel, localPanel],
}};
const state = {{
  remoteRequestView: "quick",
  remoteSearchMode: "shared",
}};

{controller}

function snapshot() {{
  return {{
    requestView: state.remoteRequestView,
    searchMode: state.remoteSearchMode,
    quick: {{ selected: quickTab.attributes["aria-selected"], tabIndex: quickTab.tabIndex, hidden: quickTab.hidden }},
    search: {{ selected: searchTab.attributes["aria-selected"], tabIndex: searchTab.tabIndex, hidden: searchTab.hidden }},
    quickPanel: {{ hidden: quickPanel.hidden, inert: quickPanel.inert }},
    searchPanel: {{ hidden: searchPanel.hidden, inert: searchPanel.inert }},
    shared: {{ selected: sharedTab.attributes["aria-selected"], tabIndex: sharedTab.tabIndex }},
    local: {{ selected: localTab.attributes["aria-selected"], tabIndex: localTab.tabIndex }},
    sharedPanel: {{ hidden: sharedPanel.hidden, inert: sharedPanel.inert }},
    localPanel: {{ hidden: localPanel.hidden, inert: localPanel.inert }},
  }};
}}

syncRemoteRequestViewSelection();
const initial = snapshot();
let prevented = 0;
const requestKeyboardTrace = [];
handleRemoteRequestTabKeydown({{
  key: "ArrowRight", currentTarget: quickTab, preventDefault() {{ prevented += 1; }},
}});
requestKeyboardTrace.push(state.remoteRequestView);
handleRemoteRequestTabKeydown({{
  key: "ArrowLeft", currentTarget: searchTab, preventDefault() {{ prevented += 1; }},
}});
requestKeyboardTrace.push(state.remoteRequestView);
handleRemoteRequestTabKeydown({{
  key: "End", currentTarget: quickTab, preventDefault() {{ prevented += 1; }},
}});
requestKeyboardTrace.push(state.remoteRequestView);
handleRemoteRequestTabKeydown({{
  key: "Home", currentTarget: searchTab, preventDefault() {{ prevented += 1; }},
}});
requestKeyboardTrace.push(state.remoteRequestView);
activeElement = "sentinel";
activateRemoteRequestView("search");
const afterSearch = {{ ...snapshot(), activeElement }};
activateRemoteSearchMode("local");
const afterLocal = snapshot();
prevented = 0;
handleRemoteSearchModeTabKeydown({{
  key: "Home", currentTarget: localTab, preventDefault() {{ prevented += 1; }},
}});
const afterKeyboard = {{ ...snapshot(), activeElement, prevented }};
const searchKeyboardTrace = [];
for (const [key, tab] of [
  ["End", sharedTab],
  ["ArrowRight", localTab],
  ["ArrowLeft", sharedTab],
  ["Home", localTab],
]) {{
  handleRemoteSearchModeTabKeydown({{
    key, currentTarget: tab, preventDefault() {{ prevented += 1; }},
  }});
  searchKeyboardTrace.push(state.remoteSearchMode);
}}
const invalidViewChanged = activateRemoteRequestView("discover");
const allRequestTabsAvailable = !quickTab.hidden && !quickTab.inert
  && !searchTab.hidden && !searchTab.inert;
const languageSelectionBefore = state.remoteRequestView;
syncRemoteRequestViewSelection();
const languageSelectionAfter = state.remoteRequestView;

console.log(JSON.stringify({{
  initial, afterSearch, afterLocal, afterKeyboard,
  requestKeyboardTrace,
  searchKeyboardTrace,
  invalidViewChanged,
  allRequestTabsAvailable,
  fetchCalls,
  languageSelectionBefore,
  languageSelectionAfter,
  stableNodes: requestForm.id === "request-form"
    && sharedForm.id === "lark-search-form"
    && localForm.id === "search-form"
    && sharedResults.children[0].id === "shared-row"
    && localResults.children[0].id === "local-row",
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

        self.assertEqual(result["initial"]["requestView"], "quick")
        self.assertEqual(result["initial"]["quick"]["tabIndex"], 0)
        self.assertTrue(result["initial"]["searchPanel"]["hidden"])
        self.assertEqual(result["afterSearch"]["requestView"], "search")
        self.assertEqual(result["afterSearch"]["activeElement"], "sentinel")
        self.assertFalse(result["afterSearch"]["searchPanel"]["hidden"])
        self.assertEqual(result["afterLocal"]["searchMode"], "local")
        self.assertTrue(result["afterLocal"]["sharedPanel"]["hidden"])
        self.assertEqual(result["afterKeyboard"]["searchMode"], "shared")
        self.assertEqual(result["afterKeyboard"]["activeElement"], "shared-tab")
        self.assertEqual(result["afterKeyboard"]["prevented"], 1)
        self.assertEqual(
            result["requestKeyboardTrace"],
            ["search", "quick", "search", "quick"],
        )
        self.assertEqual(
            result["searchKeyboardTrace"],
            ["local", "shared", "local", "shared"],
        )
        self.assertFalse(result["invalidViewChanged"])
        self.assertTrue(result["allRequestTabsAvailable"])
        self.assertEqual(
            result["languageSelectionBefore"], result["languageSelectionAfter"]
        )
        self.assertEqual(result["fetchCalls"], 0)
        self.assertTrue(result["stableNodes"])
        self.assertNotIn("fetch(", controller)

    def test_forms_have_one_submission_listener_each(self):
        for element_name in ("requestForm", "searchForm", "larkSearchForm"):
            self.assertEqual(
                len(
                    re.findall(
                        rf'elements\.{element_name}\??\.addEventListener\("submit"',
                        self.script,
                    )
                ),
                1,
            )


if __name__ == "__main__":
    unittest.main()
