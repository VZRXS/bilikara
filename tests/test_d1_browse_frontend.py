import json
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class D1BrowseFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")

    def run_load(
        self,
        relative_path: str,
        end_marker: str,
        item_limit: str,
        tag_limit: str,
        *,
        kind: str = "name",
        letter: str = "A",
        query: str = "",
        tag: str = "Alias",
    ) -> dict:
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        load_source = source[
            source.index("async function loadD1Browse(") : source.index(end_marker)
        ]
        remote_mode_helper = ""
        if relative_path == "static/remote.js":
            remote_mode_helper = """
function d1BrowseModeState(kind) {
  return state.d1BrowseModes[kind === "artist" ? "artist" : "name"];
}
"""
        script = f"""
const state = {{
  d1BrowseKind: "",
  d1BrowseLetter: "",
  d1BrowseTag: "",
  d1BrowseLocale: "",
  d1BrowseQuery: "",
  d1BrowseData: null,
  d1BrowseLoading: false,
  d1BrowseSeq: 0,
  d1BrowseModes: {{
    name: {{ letter: "", tag: "", locale: "", query: "", data: null, loading: false, seq: 0, error: "" }},
    artist: {{ letter: "", tag: "", locale: "", query: "", data: null, loading: false, seq: 0, error: "" }},
  }},
}};
const {item_limit} = 451;
const {tag_limit} = 199;
const requests = [];
function renderD1BrowseView() {{}}
{remote_mode_helper}
async function fetchD1Browse(options) {{
  requests.push(options);
  return {{ tags: [], items: [{{ bvid: "BV1xx411c7mD" }}] }};
}}
{load_source}
(async () => {{
  await loadD1Browse({{
    kind: {json.dumps(kind)},
    letter: {json.dumps(letter)},
    query: {json.dumps(query)},
    tag: {json.dumps(tag)},
    locale: "zh",
    aliases: [
      {{ tag: "Alias", locale: "zh" }},
      {{ tag: "Alias Extended", locale: "zh" }},
    ],
  }});
  const independentMode = state.d1BrowseModes[{json.dumps(kind)} === "artist" ? "artist" : "name"];
  console.log(JSON.stringify({{
    requestCount: requests.length,
    request: requests[0],
    bvid: independentMode.data?.items?.[0]?.bvid || state.d1BrowseData?.items?.[0]?.bvid,
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            [self.node, "-"],
            input=script,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def run_category_fetch(self, relative_path: str) -> dict:
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        fetch_source = source[
            source.index("function uniqueD1BrowseTags(") : source.index(
                "async function fetchGatchaBrowse(",
            )
        ]
        script = f"""
const requests = [];
function categoryBrowseUsesFullFieldSearch() {{ return false; }}
function clientHeaders() {{ return {{}}; }}
function localizedApiMessage(value) {{ return value; }}
function t(key) {{ return key; }}
async function fetch(url) {{
  requests.push(url);
  return {{
    ok: true,
    async json() {{ return {{ ok: true, data: {{ items: [] }} }}; }},
  }};
}}
{fetch_source}
(async () => {{
  const data = await fetchD1CategoryBrowse({{
    tags: [" Alias ", "Alias", "", "Second"],
    query: " query ",
    offset: 5,
    limit: 10,
  }});
  console.log(JSON.stringify({{ requests, data }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            [self.node, "-"],
            input=script,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_host_uses_one_indexed_browse_request(self):
        result = self.run_load(
            "static/app.js",
            "function ensurePendingReviewView(",
            "D1_BROWSE_ITEM_LIMIT",
            "D1_BROWSE_TAG_LIMIT",
        )

        self.assertEqual(result["requestCount"], 1)
        self.assertEqual(result["request"]["tag"], "Alias")
        self.assertEqual(result["request"]["limit"], 451)
        self.assertEqual(result["bvid"], "BV1xx411c7mD")

    def test_remote_uses_one_indexed_browse_request(self):
        result = self.run_load(
            "static/remote.js",
            "function ensureCategoryBrowseView(",
            "d1BrowseItemLimit",
            "d1BrowseTagLimit",
        )

        self.assertEqual(result["requestCount"], 1)
        self.assertEqual(result["request"]["tag"], "Alias")
        self.assertEqual(result["request"]["limit"], 451)
        self.assertEqual(result["bvid"], "BV1xx411c7mD")

    def test_host_category_browse_deduplicates_tags_without_removed_alias_helper(self):
        result = self.run_category_fetch("static/app.js")
        self.assertEqual(len(result["requests"]), 1)
        self.assertEqual(result["requests"][0].count("tag45=Alias"), 1)
        self.assertIn("tag45=Second", result["requests"][0])
        self.assertIn("q=query", result["requests"][0])

    def test_remote_category_browse_deduplicates_tags_without_removed_alias_helper(self):
        result = self.run_category_fetch("static/remote.js")
        self.assertEqual(len(result["requests"]), 1)
        self.assertEqual(result["requests"][0].count("tag45=Alias"), 1)
        self.assertIn("tag45=Second", result["requests"][0])
        self.assertIn("q=query", result["requests"][0])

    def test_tagless_browse_uses_tag_limit_and_forwards_query_and_letter(self):
        cases = (
            ("static/app.js", "function ensurePendingReviewView(", "D1_BROWSE_ITEM_LIMIT", "D1_BROWSE_TAG_LIMIT"),
            ("static/remote.js", "function ensureCategoryBrowseView(", "d1BrowseItemLimit", "d1BrowseTagLimit"),
        )
        for relative_path, end_marker, item_limit, tag_limit in cases:
            with self.subTest(relative_path=relative_path):
                result = self.run_load(
                    relative_path,
                    end_marker,
                    item_limit,
                    tag_limit,
                    letter="b",
                    query="Love Live",
                    tag="",
                )

                self.assertEqual(result["requestCount"], 1)
                self.assertEqual(result["request"]["tag"], "")
                self.assertEqual(result["request"]["letter"], "B")
                self.assertEqual(result["request"]["query"], "Love Live")
                self.assertEqual(result["request"]["limit"], 199)

    def test_artist_browse_uses_one_tagged_item_request_on_host_and_remote(self):
        cases = (
            ("static/app.js", "function ensurePendingReviewView(", "D1_BROWSE_ITEM_LIMIT", "D1_BROWSE_TAG_LIMIT"),
            ("static/remote.js", "function ensureCategoryBrowseView(", "d1BrowseItemLimit", "d1BrowseTagLimit"),
        )
        for relative_path, end_marker, item_limit, tag_limit in cases:
            with self.subTest(relative_path=relative_path):
                result = self.run_load(
                    relative_path,
                    end_marker,
                    item_limit,
                    tag_limit,
                    kind="artist",
                    letter="C",
                    query="Singer",
                    tag="Artist Alias",
                )

                self.assertEqual(result["requestCount"], 1)
                self.assertEqual(result["request"]["kind"], "artist")
                self.assertEqual(result["request"]["tag"], "Artist Alias")
                self.assertEqual(result["request"]["letter"], "C")
                self.assertEqual(result["request"]["query"], "Singer")
                self.assertEqual(result["request"]["limit"], 451)


if __name__ == "__main__":
    unittest.main()
