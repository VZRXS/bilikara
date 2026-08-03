import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class RemoteSearchExpansionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        source = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.search_source = source[
            source.index("const canonicalBilikaraSearch =") :
            source.index("function normalizeD1BrowseTagForMerge(")
        ]
        cls.input_handlers = source[
            source.index('elements.larkSearchQuery?.addEventListener("input"') :
            source.index('elements.larkSearchResults?.addEventListener("click"')
        ]
        cls.expand_handler = source[
            source.index('elements.searchLibraryOpen?.addEventListener("click"') :
            source.index('elements.searchModalClose?.addEventListener("click"')
        ]

    def run_node(self, body: str) -> dict:
        script = f"""
const searchResultItemByElement = new WeakMap();

function mockElement(id) {{
  const listeners = new Map();
  return {{
    id, value: "", disabled: false, innerHTML: "", children: [],
    classList: {{
      values: new Set(["hidden"]),
      add(...names) {{ names.forEach((name) => this.values.add(name)); }},
      remove(...names) {{ names.forEach((name) => this.values.delete(name)); }},
      contains(name) {{ return this.values.has(name); }},
      toggle(name, force) {{
        if (force === undefined ? !this.values.has(name) : force) this.values.add(name);
        else this.values.delete(name);
      }},
    }},
    addEventListener(name, callback) {{
      const current = listeners.get(name) || [];
      current.push(callback);
      listeners.set(name, current);
    }},
    async dispatch(name) {{
      const event = {{ preventDefault() {{}}, target: this }};
      for (const callback of listeners.get(name) || []) await callback(event);
    }},
    focus() {{}},
  }};
}}

const elements = {{
  larkSearchQuery: mockElement("lark-search-query"),
  searchModalLarkQuery: mockElement("search-modal-lark-query"),
  larkSearchResults: mockElement("lark-search-results"),
  searchModalLarkResults: mockElement("search-modal-lark-results"),
  larkSearchButton: mockElement("lark-search-button"),
  searchModalLarkButton: mockElement("search-modal-lark-button"),
  larkSearchMessage: mockElement("lark-search-message"),
  searchModalLarkMessage: mockElement("search-modal-lark-message"),
  larkSearchForm: mockElement("lark-search-form"),
  searchModalLarkForm: mockElement("search-modal-lark-form"),
  searchLibraryOpen: mockElement("search-library-open"),
}};

function t(key, params) {{ return params?.count === undefined ? key : `${{key}}:${{params.count}}`; }}
function setLarkSearchMessage(message, isError) {{
  elements.larkSearchMessage.textContent = message;
  elements.larkSearchMessage.isError = Boolean(isError);
}}
function setSearchModalLarkMessage(message, isError) {{
  elements.searchModalLarkMessage.textContent = message;
  elements.searchModalLarkMessage.isError = Boolean(isError);
}}
function hideLarkSearchResults() {{
  elements.larkSearchResults.children = [];
  elements.larkSearchResults.classList.add("hidden");
}}
function renderLarkSearchResults(items) {{
  elements.larkSearchResults.children = items.map((item) => {{
    const row = {{ view: "compact" }};
    searchResultItemByElement.set(row, item);
    return row;
  }});
  elements.larkSearchResults.classList.remove("hidden");
}}
function renderSearchResultItems(container, items) {{
  container.children = items.map((item) => {{
    const row = {{ view: "detailed" }};
    searchResultItemByElement.set(row, item);
    return row;
  }});
  container.classList.remove("hidden");
}}

const requests = [];
const resolvers = new Map();
function searchLarkPool(query) {{
  requests.push(query);
  return new Promise((resolve, reject) => resolvers.set(query, {{ resolve, reject }}));
}}

let modalOpenCount = 0;
function setSearchModalOpen(open) {{
  if (!open) return;
  modalOpenCount += 1;
  syncBilikaraSearchViews();
}}

{self.search_source}
{self.input_handlers}
{self.expand_handler}

(async () => {{
  {body}
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            [self.node, "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_actual_expand_click_is_request_free_and_switches_only_modal_style(self):
        result = self.run_node(
            """
const item = { bvid: "BV1", title: "song", url: "https://example/BV1" };
const search = executeCanonicalBilikaraSearch("VZRXS");
resolvers.get("VZRXS").resolve([item]);
await search;
const callsBeforeExpand = requests.length;
const inlineRow = elements.larkSearchResults.children[0];
await elements.searchLibraryOpen.dispatch("click");
const modalRow = elements.searchModalLarkResults.children[0];
console.log(JSON.stringify({
  calls: requests.length - callsBeforeExpand,
  modalOpenCount,
  inlineStyle: inlineRow.view,
  modalStyle: modalRow.view,
  inlineIdentity: searchResultItemByElement.get(inlineRow) === item,
  modalIdentity: searchResultItemByElement.get(modalRow) === item,
}));
"""
        )
        self.assertEqual(result["calls"], 0)
        self.assertEqual(result["modalOpenCount"], 1)
        self.assertEqual(result["inlineStyle"], "compact")
        self.assertEqual(result["modalStyle"], "detailed")
        self.assertTrue(result["inlineIdentity"])
        self.assertTrue(result["modalIdentity"])

    def test_request_a_cannot_overwrite_later_request_b(self):
        result = self.run_node(
            """
const itemA = { bvid: "A" };
const itemB = { bvid: "B" };
const requestA = executeCanonicalBilikaraSearch("query A");
const requestB = executeCanonicalBilikaraSearch("query B");
resolvers.get("query B").resolve([itemB]);
await requestB;
resolvers.get("query A").resolve([itemA]);
await requestA;
console.log(JSON.stringify({
  draft: canonicalBilikaraSearch.draftQuery,
  committed: canonicalBilikaraSearch.resultQuery,
  bvid: canonicalBilikaraSearch.items[0]?.bvid,
}));
"""
        )
        self.assertEqual(result, {"draft": "query B", "committed": "query B", "bvid": "B"})

    def test_actual_empty_submit_invalidates_inflight_request(self):
        result = self.run_node(
            """
const requestA = executeCanonicalBilikaraSearch("query A");
elements.larkSearchQuery.value = "";
await elements.larkSearchForm.dispatch("submit");
resolvers.get("query A").resolve([{ bvid: "A" }]);
await requestA;
console.log(JSON.stringify({
  draft: canonicalBilikaraSearch.draftQuery,
  committed: canonicalBilikaraSearch.resultQuery,
  itemCount: canonicalBilikaraSearch.items.length,
  buttonDisabled: elements.larkSearchButton.disabled,
}));
"""
        )
        self.assertEqual(result["draft"], "")
        self.assertEqual(result["committed"], "")
        self.assertEqual(result["itemCount"], 0)
        self.assertFalse(result["buttonDisabled"])

    def test_actual_input_edit_invalidates_inflight_results_and_busy_state(self):
        result = self.run_node(
            """
const requestA = executeCanonicalBilikaraSearch("query A");
elements.searchModalLarkQuery.value = "draft B";
await elements.searchModalLarkQuery.dispatch("input");
resolvers.get("query A").resolve([{ bvid: "A" }]);
await requestA;
console.log(JSON.stringify({
  draft: canonicalBilikaraSearch.draftQuery,
  committed: canonicalBilikaraSearch.resultQuery,
  inlineInput: elements.larkSearchQuery.value,
  itemCount: canonicalBilikaraSearch.items.length,
  inlineDisabled: elements.larkSearchButton.disabled,
  modalDisabled: elements.searchModalLarkButton.disabled,
}));
"""
        )
        self.assertEqual(result["draft"], "draft B")
        self.assertEqual(result["committed"], "")
        self.assertEqual(result["inlineInput"], "draft B")
        self.assertEqual(result["itemCount"], 0)
        self.assertFalse(result["inlineDisabled"])
        self.assertFalse(result["modalDisabled"])


if __name__ == "__main__":
    unittest.main()
