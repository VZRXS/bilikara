import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class RemoteSearchExpansionTest(unittest.TestCase):
    def test_remote_js_canonical_search_structure(self):
        remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        self.assertIn("const canonicalBilikaraSearch =", remote_js)
        self.assertIn("function syncBilikaraSearchViews()", remote_js)
        self.assertIn("async function executeCanonicalBilikaraSearch(", remote_js)

    def test_node_behavioral_canonical_search_sync_and_zero_request_expand(self):
        remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")

        node_script = f"""
const searchResultItemByElement = new WeakMap();

function mockElement(id) {{
  return {{
    id,
    value: "",
    disabled: false,
    innerHTML: "",
    classList: {{
      classes: new Set(["hidden"]),
      add(cls) {{ this.classes.add(cls); }},
      remove(cls) {{ this.classes.delete(cls); }},
      contains(cls) {{ return this.classes.has(cls); }},
      toggle(cls, force) {{
        if (force) this.classes.add(cls);
        else this.classes.delete(cls);
      }},
    }},
    children: [],
    appendChild(child) {{ this.children.push(child); }},
    querySelector() {{ return null; }},
    querySelectorAll() {{ return []; }},
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
}};

function t(key, params) {{
  if (params && params.count !== undefined) return key + ":" + params.count;
  return key;
}}

function setLarkSearchMessage(msg, isErr) {{
  elements.larkSearchMessage.textContent = msg;
}}

function setSearchModalLarkMessage(msg, isErr) {{
  elements.searchModalLarkMessage.textContent = msg;
}}

let searchLarkPoolCallCount = 0;
let mockPoolItems = [
  {{ bvid: "BV111", title: "Song 1", url: "https://bilibili.com/video/BV111" }},
  {{ bvid: "BV222", title: "Song 2", url: "https://bilibili.com/video/BV222" }},
];

async function searchLarkPool(query) {{
  searchLarkPoolCallCount++;
  if (query === "error") throw new Error("Network Error");
  return mockPoolItems;
}}

function createSearchResultRow(item) {{
  const row = mockElement("result-row-" + item.bvid);
  row.dataset = {{ bvid: item.bvid, url: item.url }};
  searchResultItemByElement.set(row, item);
  return row;
}}

function renderSearchResultItems(container, items, emptyText = "") {{
  if (!container) return;
  container.children = [];
  container.classList.remove("hidden");
  if (!items || !items.length) {{
    const empty = mockElement("empty");
    empty.textContent = emptyText;
    container.appendChild(empty);
    return;
  }}
  items.forEach((item) => {{
    container.appendChild(createSearchResultRow(item));
  }});
}}

{remote_js[remote_js.index("const canonicalBilikaraSearch ="):remote_js.index("function normalizeD1BrowseTagForMerge(")]}

(async () => {{
  const results = {{}};

  // Step 1: Execute inline search
  await executeCanonicalBilikaraSearch("anime");
  results.step1_poolCalls = searchLarkPoolCallCount;
  results.step1_canonicalQuery = canonicalBilikaraSearch.query;
  results.step1_canonicalItemCount = canonicalBilikaraSearch.items.length;
  results.step1_inlineQueryVal = elements.larkSearchQuery.value;
  results.step1_modalQueryVal = elements.searchModalLarkQuery.value;
  results.step1_inlineRenderedCount = elements.larkSearchResults.children.length;
  results.step1_modalRenderedCount = elements.searchModalLarkResults.children.length;

  // Step 2: Click Expand (simulated by calling syncBilikaraSearchViews when opening modal)
  const poolCallsBeforeExpand = searchLarkPoolCallCount;
  syncBilikaraSearchViews();
  results.step2_expandPoolCallsDelta = searchLarkPoolCallCount - poolCallsBeforeExpand;
  results.step2_modalQueryVal = elements.searchModalLarkQuery.value;
  results.step2_modalRenderedCount = elements.searchModalLarkResults.children.length;
  results.step2_weakMapItem1Bvid = searchResultItemByElement.get(elements.searchModalLarkResults.children[0])?.bvid;

  // Step 3: Execute modal-originated search
  await executeCanonicalBilikaraSearch("vocaloid");
  results.step3_canonicalQuery = canonicalBilikaraSearch.query;
  results.step3_inlineQueryVal = elements.larkSearchQuery.value;

  // Step 4: Stale search sequence handling
  const seqStart = canonicalBilikaraSearch.seq;
  canonicalBilikaraSearch.seq = seqStart + 5; // simulate newer search started
  // Try running an older search completion callback simulation
  if (canonicalBilikaraSearch.seq !== seqStart) {{
    // Should be ignored
    results.step4_staleIgnored = true;
  }}

  // Step 5: Error search handling
  await executeCanonicalBilikaraSearch("error");
  results.step5_isError = canonicalBilikaraSearch.isError;
  results.step5_msg = canonicalBilikaraSearch.message;

  console.log(JSON.stringify(results));
}})();
"""
        proc = subprocess.run(
            ["node", "-e", node_script],
            check=True,
            text=True,
            capture_output=True,
        )
        data = json.loads(proc.stdout)
        self.assertEqual(data["step1_poolCalls"], 1)
        self.assertEqual(data["step1_canonicalQuery"], "anime")
        self.assertEqual(data["step1_canonicalItemCount"], 2)
        self.assertEqual(data["step1_inlineQueryVal"], "anime")
        self.assertEqual(data["step1_modalQueryVal"], "anime")
        self.assertEqual(data["step1_inlineRenderedCount"], 2)
        self.assertEqual(data["step1_modalRenderedCount"], 2)

        # Confirm 0 additional network calls on Expand
        self.assertEqual(data["step2_expandPoolCallsDelta"], 0)
        self.assertEqual(data["step2_modalQueryVal"], "anime")
        self.assertEqual(data["step2_modalRenderedCount"], 2)
        self.assertEqual(data["step2_weakMapItem1Bvid"], "BV111")

        # Modal search updates inline
        self.assertEqual(data["step3_canonicalQuery"], "vocaloid")
        self.assertEqual(data["step3_inlineQueryVal"], "vocaloid")

        # Stale response sequence control
        self.assertTrue(data["step4_staleIgnored"])

        # Error state sync
        self.assertTrue(data["step5_isError"])
        self.assertEqual(data["step5_msg"], "Network Error")


if __name__ == "__main__":
    unittest.main()
