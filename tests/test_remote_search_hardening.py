from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class RemoteSearchHardeningTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.source = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.css = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")
        cls.cover_source = cls._slice(
            "function appendSearchResultCoverFallback", "function createSearchResultRow"
        )
        cls.render_source = cls._slice(
            "function renderSearchResultItems", "function appendSearchResultItems"
        )
        cls.sync_source = cls._slice(
            "function syncBilikaraSearchView", "async function executeCanonicalBilikaraSearch"
        )

    @classmethod
    def _slice(cls, start: str, end: str) -> str:
        start_index = cls.source.index(start)
        return cls.source[start_index : cls.source.index(end, start_index)]

    def run_node(self, script: str) -> dict:
        completed = subprocess.run(
            [
                self.node,
                "-e",
                f"(async () => {{\n{script}\n}})().catch((error) => {{ console.error(error); process.exit(1); }});",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout.strip().splitlines()[-1])

    def test_inline_browse_results_leave_vertical_scroll_to_the_document(self):
        result_rule = self.css.split(
            ".remote-search-browser-view .search-results", 1
        )[1].split("}", 1)[0]
        for declaration in (
            "min-height: 0;",
            "max-height: none;",
            "overflow: visible;",
            "overscroll-behavior: auto;",
        ):
            self.assertIn(declaration, result_rule)
        for obsolete in (
            ".remote-search-modal",
            "body.remote-search-modal-open",
        ):
            self.assertNotIn(obsolete, self.css)
        self.assertNotIn("-webkit-overflow-scrolling: touch", result_rule)

    def test_initial_cover_batch_is_eager_and_image_failure_has_fallback(self):
        result = self.run_node(
            f"""
class MockClassList {{
  constructor() {{ this.values = new Set(); }}
  add(...names) {{ names.forEach((name) => this.values.add(name)); }}
  toggle(name, force) {{
    if (force === undefined ? !this.values.has(name) : force) this.values.add(name);
    else this.values.delete(name);
  }}
  contains(name) {{ return this.values.has(name); }}
}}
class MockElement {{
  constructor(tagName) {{
    this.tagName = tagName;
    this.className = "";
    this.classList = new MockClassList();
    this.dataset = {{}};
    this.children = [];
    this.parentElement = null;
    this.textContent = "";
  }}
  appendChild(child) {{ child.parentElement = this; this.children.push(child); return child; }}
  remove() {{
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }}
  set src(value) {{ this.source = value; }}
  get src() {{ return this.source; }}
}}
const document = {{ createElement(tagName) {{ return new MockElement(tagName); }} }};
function searchResultCoverUrl(item) {{ return String(item?.cover_url || ""); }}
function formatSearchDuration() {{ return ""; }}
function firstSearchResultValue() {{ return ""; }}
function createSearchResultRatingStars() {{ return null; }}
{self.cover_source}

const eager = createSearchResultCover({{ bvid: "BV-EAGER", cover_url: "https://example.test/eager.jpg" }}, {{ eagerCover: true }});
const eagerImage = eager.children[0];
const lazy = createSearchResultCover({{ bvid: "BV-LAZY", cover_url: "https://example.test/lazy.jpg" }});
const lazyImage = lazy.children[0];
lazyImage.onload();
eagerImage.onerror();
const missing = createSearchResultCover({{ bvid: "BV-MISSING" }});

console.log(JSON.stringify({{
  eagerLoading: eagerImage.loading,
  eagerReferrerPolicy: eagerImage.referrerPolicy,
  eagerState: eager.dataset.coverState,
  eagerFallback: eager.children[0]?.className,
  eagerFallbackText: eager.children[0]?.textContent,
  eagerErrorClass: eager.classList.contains("is-error"),
  lazyLoading: lazyImage.loading,
  lazyState: lazy.dataset.coverState,
  missingState: missing.dataset.coverState,
  missingFallback: missing.children[0]?.className,
}}));
"""
        )
        self.assertEqual(
            result,
            {
                "eagerLoading": "eager",
                "eagerReferrerPolicy": "no-referrer",
                "eagerState": "error",
                "eagerFallback": "search-result-cover-fallback",
                "eagerFallbackText": "BV-EAGER",
                "eagerErrorClass": True,
                "lazyLoading": "lazy",
                "lazyState": "loaded",
                "missingState": "missing",
                "missingFallback": "search-result-cover-fallback",
            },
        )

        batch = self.run_node(
            f"""
const expandedSearchEagerCoverCount = 6;
const rows = [];
const container = {{
  _innerHTML: "",
  classList: {{ remove() {{}} }},
  children: [],
  set innerHTML(value) {{ this._innerHTML = value; this.children = []; }},
  appendChild(child) {{ this.children.push(child); }},
}};
function createSearchResultRow(item, options) {{
  const row = {{ id: item.id, eagerCover: options.eagerCover }};
  rows.push(row);
  return row;
}}
function applyRequestResultSelection() {{}}
function requestDetailOwnerForContainer() {{ return "categories"; }}
function t(key) {{ return key; }}
const document = {{ createElement() {{ return {{}}; }} }};
{self.render_source}
renderSearchResultItems(container, Array.from({{ length: 8 }}, (_, index) => ({{ id: index }})));
console.log(JSON.stringify({{ eager: rows.map((row) => row.eagerCover) }}));
"""
        )
        self.assertEqual(batch["eager"], [True, True, True, True, True, True, False, False])

    def test_pending_shared_search_keeps_same_result_container_mounted(self):
        result = self.run_node(
            f"""
class MockClassList {{
  constructor(...names) {{ this.values = new Set(names); }}
  add(...names) {{ names.forEach((name) => this.values.add(name)); }}
  remove(...names) {{ names.forEach((name) => this.values.delete(name)); }}
  contains(name) {{ return this.values.has(name); }}
  toggle(name, force) {{
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }}
}}
class MockResults {{
  constructor() {{
    this.classList = new MockClassList("hidden");
    this.children = [];
    this._innerHTML = "";
  }}
  set innerHTML(value) {{ this._innerHTML = value; this.children = []; }}
  get innerHTML() {{ return this._innerHTML; }}
  appendChild(child) {{ this.children.push(child); return child; }}
}}
const sharedResults = new MockResults();
const elements = {{
  larkSearchQuery: {{ value: "pending query" }},
  larkSearchResults: sharedResults,
}};
const canonicalBilikaraSearch = {{
  query: "pending query",
  items: [],
  message: "searching",
  isError: false,
  hasSearched: true,
  seq: 1,
  loading: true,
}};
function setLarkSearchMessage() {{}}
function t(key) {{ return key; }}
const rows = [];
function createSearchResultRow(item, options) {{
  const row = {{ id: item.id, eagerCover: options.eagerCover }};
  rows.push(row);
  return row;
}}
const expandedSearchEagerCoverCount = 6;
const document = {{ body: {{ classList: new MockClassList() }}, createElement() {{ return {{}}; }} }};
function renderLarkSearchResults(items) {{
  sharedResults.innerHTML = "";
  sharedResults.classList.remove("hidden");
  items.forEach((item) => sharedResults.appendChild(createSearchResultRow(item, {{ eagerCover: false }})));
}}

{self.render_source}
{self.sync_source}

syncBilikaraSearchView();
const pending = {{
  sameContainer: elements.larkSearchResults === sharedResults,
  hidden: sharedResults.classList.contains("hidden"),
  childCount: sharedResults.children.length,
}};

canonicalBilikaraSearch.items = Array.from({{ length: 8 }}, (_, index) => ({{ id: index }}));
canonicalBilikaraSearch.message = "found";
canonicalBilikaraSearch.loading = false;
syncBilikaraSearchView();
console.log(JSON.stringify({{
  pending,
  completed: {{
    sameContainer: elements.larkSearchResults === sharedResults,
    hidden: sharedResults.classList.contains("hidden"),
    rowCount: sharedResults.children.length,
    rowIds: sharedResults.children.map((row) => row.id),
  }},
}}));
"""
        )

        self.assertEqual(
            result["pending"],
            {
                "sameContainer": True,
                "hidden": True,
                "childCount": 0,
            },
        )
        self.assertEqual(
            result["completed"],
            {
                "sameContainer": True,
                "hidden": False,
                "rowCount": 8,
                "rowIds": list(range(8)),
            },
        )

    def test_playback_sheet_has_no_drag_or_swipe_handlers(self):
        sheet_source = self._slice("function openPlaybackSheet", "async function startRemoteSession")
        for forbidden in (
            "makeElementDraggable",
            "touchstart",
            "touchmove",
            "touchend",
            "pointermove",
            "mousedown",
            "mousemove",
        ):
            self.assertNotIn(forbidden, sheet_source)
        self.assertIn("elements.playbackDock?.addEventListener(\"click\", openPlaybackSheet)", sheet_source)
        self.assertIn("elements.playbackSheetCollapse?.addEventListener(\"click\"", sheet_source)
        self.assertIn("elements.playbackSheetBackdrop?.addEventListener(\"click\"", sheet_source)

if __name__ == "__main__":
    unittest.main()
