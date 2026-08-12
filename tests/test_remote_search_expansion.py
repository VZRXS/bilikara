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
            source.index("function d1BrowseTitle(")
        ]
        cls.modal_submit_handler = source[
            source.index('elements.searchModalLarkForm?.addEventListener("submit"') :
            source.index('elements.searchModalLarkResults?.addEventListener("click"')
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
  elements.larkSearchResults.children = items.length ? items.map((item) => {{
    const row = {{ view: "compact" }};
    searchResultItemByElement.set(row, item);
    return row;
  }}) : [{{ className: "search-empty", textContent: t("search.larkNoResults") }}];
  elements.larkSearchResults.classList.remove("hidden");
}}
function renderSearchResultItems(container, items, emptyText = "") {{
  container.children = items.length ? items.map((item) => {{
    const row = {{ view: "detailed" }};
    searchResultItemByElement.set(row, item);
    return row;
  }}) : [{{ className: "search-empty", textContent: emptyText || t("search.empty") }}];
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
{self.modal_submit_handler}
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
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_inline_search_and_modal_sync(self):
        result = self.run_node(
            """
const item1 = { bvid: "BV1", title: "anime 1" };
const item2 = { bvid: "BV2", title: "anime 2" };

// Step 1: inline search "anime"
elements.larkSearchQuery.value = "anime";
const searchPromise = elements.larkSearchForm.dispatch("submit");
const callsAfterSubmit = requests.length;
resolvers.get("anime").resolve([item1, item2]);
await searchPromise;

const inlineResultsCount = elements.larkSearchResults.children.length;
const inlineRow0 = elements.larkSearchResults.children[0];

// 2. Open modal / sync modal
const callsBeforeModal = requests.length;
await elements.searchLibraryOpen.dispatch("click");
const callsAfterModal = requests.length;
const modalQuery = elements.searchModalLarkQuery.value;
const modalResultsCount = elements.searchModalLarkResults.children.length;
const modalRow0 = elements.searchModalLarkResults.children[0];

console.log(JSON.stringify({
  networkCallsOnSearch: callsAfterSubmit,
  additionalNetworkCallsOnModal: callsAfterModal - callsBeforeModal,
  modalQuery,
  inlineResultsCount,
  modalResultsCount,
  inlineRow0MatchesItem1: searchResultItemByElement.get(inlineRow0) === item1,
  modalRow0MatchesItem1: searchResultItemByElement.get(modalRow0) === item1,
}));
"""
        )
        self.assertEqual(result["networkCallsOnSearch"], 1)
        self.assertEqual(result["additionalNetworkCallsOnModal"], 0)
        self.assertEqual(result["modalQuery"], "anime")
        self.assertEqual(result["inlineResultsCount"], 2)
        self.assertEqual(result["modalResultsCount"], 2)
        self.assertTrue(result["inlineRow0MatchesItem1"])
        self.assertTrue(result["modalRow0MatchesItem1"])

    def test_modal_search_syncs_to_inline(self):
        result = self.run_node(
            """
const item = { bvid: "BV_VOC", title: "vocaloid 1" };
elements.searchModalLarkQuery.value = "vocaloid";
await elements.searchModalLarkQuery.dispatch("input");

const searchPromise = elements.searchModalLarkForm.dispatch("submit");
resolvers.get("vocaloid").resolve([item]);
await searchPromise;

console.log(JSON.stringify({
  inlineQuery: elements.larkSearchQuery.value,
  inlineResultsCount: elements.larkSearchResults.children.length,
  modalResultsCount: elements.searchModalLarkResults.children.length,
  inlineRowMatchesItem: searchResultItemByElement.get(elements.larkSearchResults.children[0]) === item,
}));
"""
        )
        self.assertEqual(result["inlineQuery"], "vocaloid")
        self.assertEqual(result["inlineResultsCount"], 1)
        self.assertEqual(result["modalResultsCount"], 1)
        self.assertTrue(result["inlineRowMatchesItem"])

    def test_no_results_appear_only_after_pending_request_resolves_empty(self):
        result = self.run_node(
            """
elements.larkSearchQuery.value = "anime";
const searchPromise = elements.larkSearchForm.dispatch("submit");

const pending = {
  message: elements.larkSearchMessage.textContent,
  modalMessage: elements.searchModalLarkMessage.textContent,
  inlineEmptyRows: elements.larkSearchResults.children.filter((row) => row.className === "search-empty").length,
  modalEmptyRows: elements.searchModalLarkResults.children.filter((row) => row.className === "search-empty").length,
};

resolvers.get("anime").resolve([]);
await searchPromise;

console.log(JSON.stringify({
  pending,
  settled: {
    inlineText: elements.larkSearchResults.children[0]?.textContent,
    modalText: elements.searchModalLarkResults.children[0]?.textContent,
    inlineEmptyRows: elements.larkSearchResults.children.filter((row) => row.className === "search-empty").length,
    modalEmptyRows: elements.searchModalLarkResults.children.filter((row) => row.className === "search-empty").length,
  },
}));
"""
        )
        self.assertEqual(result["pending"]["message"], "search.larkSearching")
        self.assertEqual(result["pending"]["modalMessage"], "search.larkSearching")
        self.assertEqual(result["pending"]["inlineEmptyRows"], 0)
        self.assertEqual(result["pending"]["modalEmptyRows"], 0)
        self.assertEqual(result["settled"]["inlineEmptyRows"], 1)
        self.assertEqual(result["settled"]["modalEmptyRows"], 1)
        self.assertEqual(result["settled"]["inlineText"], "search.larkNoResults")
        self.assertEqual(result["settled"]["modalText"], "search.larkNoResults")

    def test_stale_request_completion_does_not_overwrite_newer_state(self):
        result = self.run_node(
            """
const itemA = { bvid: "A" };
const itemB = { bvid: "B" };
elements.larkSearchQuery.value = "query A";
const requestA = elements.larkSearchForm.dispatch("submit");

elements.larkSearchQuery.value = "query B";
const requestB = elements.larkSearchForm.dispatch("submit");

resolvers.get("query B").resolve([itemB]);
await requestB;

resolvers.get("query A").resolve([itemA]);
await requestA;

console.log(JSON.stringify({
  canonicalQuery: canonicalBilikaraSearch.query,
  itemBvid: canonicalBilikaraSearch.items[0]?.bvid,
  inlineQuery: elements.larkSearchQuery.value,
  modalQuery: elements.searchModalLarkQuery.value,
}));
"""
        )
        self.assertEqual(result["canonicalQuery"], "query B")
        self.assertEqual(result["itemBvid"], "B")
        self.assertEqual(result["inlineQuery"], "query B")
        self.assertEqual(result["modalQuery"], "query B")


if __name__ == "__main__":
    unittest.main()
