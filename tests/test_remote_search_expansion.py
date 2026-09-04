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
        cls.form_handlers = source[
            source.index('elements.larkSearchQuery?.addEventListener("input"') :
            source.index('elements.larkSearchResults?.addEventListener("click"')
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
    setAttribute(name, value) {{ this[name] = String(value); }},
    removeAttribute(name) {{ delete this[name]; }},
  }};
}}

const elements = {{
  larkSearchQuery: mockElement("lark-search-query"),
  larkSearchResults: mockElement("lark-search-results"),
  larkSearchButton: mockElement("lark-search-button"),
  larkSearchMessage: mockElement("lark-search-message"),
  larkSearchForm: mockElement("lark-search-form"),
}};

function t(key, params) {{ return params?.count === undefined ? key : `${{key}}:${{params.count}}`; }}
function setLarkSearchMessage(message, isError) {{
  elements.larkSearchMessage.textContent = message;
  elements.larkSearchMessage.isError = Boolean(isError);
}}
function renderLarkSearchResults(items) {{
  elements.larkSearchResults.children = items.length ? items.map((item) => {{
    const row = {{ view: "compact" }};
    searchResultItemByElement.set(row, item);
    return row;
  }}) : [{{ className: "search-empty", textContent: t("search.larkNoResults") }}];
  elements.larkSearchResults.classList.remove("hidden");
}}

const requests = [];
const resolvers = new Map();
function searchLarkPool(query) {{
  requests.push(query);
  return new Promise((resolve, reject) => resolvers.set(query, {{ resolve, reject }}));
}}

{self.search_source}
{self.form_handlers}

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

    def test_shared_search_has_one_live_owner_and_one_network_request(self):
        result = self.run_node(
            """
const item1 = { bvid: "BV1", title: "anime 1" };
const item2 = { bvid: "BV2", title: "anime 2" };
elements.larkSearchQuery.value = "anime";
await elements.larkSearchQuery.dispatch("input");
const searchPromise = elements.larkSearchForm.dispatch("submit");
resolvers.get("anime").resolve([item1, item2]);
await searchPromise;
console.log(JSON.stringify({
  requests,
  canonicalQuery: canonicalBilikaraSearch.query,
  inputQuery: elements.larkSearchQuery.value,
  resultCount: elements.larkSearchResults.children.length,
  firstRowMatches: searchResultItemByElement.get(elements.larkSearchResults.children[0]) === item1,
  buttonDisabled: elements.larkSearchButton.disabled,
}));
"""
        )
        self.assertEqual(result["requests"], ["anime"])
        self.assertEqual(result["canonicalQuery"], "anime")
        self.assertEqual(result["inputQuery"], "anime")
        self.assertEqual(result["resultCount"], 2)
        self.assertTrue(result["firstRowMatches"])
        self.assertFalse(result["buttonDisabled"])

    def test_no_results_appear_only_after_pending_request_resolves_empty(self):
        result = self.run_node(
            """
elements.larkSearchQuery.value = "anime";
const searchPromise = elements.larkSearchForm.dispatch("submit");
const pending = {
  message: elements.larkSearchMessage.textContent,
  emptyRows: elements.larkSearchResults.children.filter((row) => row.className === "search-empty").length,
  hidden: elements.larkSearchResults.classList.contains("hidden"),
};
resolvers.get("anime").resolve([]);
await searchPromise;
console.log(JSON.stringify({
  pending,
  settled: {
    message: elements.larkSearchMessage.textContent,
    emptyRows: elements.larkSearchResults.children.filter((row) => row.className === "search-empty").length,
    emptyText: elements.larkSearchResults.children[0]?.textContent,
  },
}));
"""
        )
        self.assertEqual(result["pending"]["message"], "search.larkSearching")
        self.assertEqual(result["pending"]["emptyRows"], 0)
        self.assertTrue(result["pending"]["hidden"])
        self.assertEqual(result["settled"]["message"], "search.larkNoResults")
        self.assertEqual(result["settled"]["emptyRows"], 1)
        self.assertEqual(result["settled"]["emptyText"], "search.larkNoResults")

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
  inputQuery: elements.larkSearchQuery.value,
  requestCount: requests.length,
}));
"""
        )
        self.assertEqual(result["canonicalQuery"], "query B")
        self.assertEqual(result["itemBvid"], "B")
        self.assertEqual(result["inputQuery"], "query B")
        self.assertEqual(result["requestCount"], 2)


if __name__ == "__main__":
    unittest.main()
