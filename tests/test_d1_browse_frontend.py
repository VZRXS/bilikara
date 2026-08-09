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

    def run_load(self, relative_path: str, end_marker: str, item_limit: str, tag_limit: str) -> dict:
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        load_source = source[
            source.index("async function loadD1Browse(") : source.index(end_marker)
        ]
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
}};
const {item_limit} = 450;
const {tag_limit} = 450;
const requests = [];
function renderD1BrowseView() {{}}
async function fetchD1Browse(options) {{
  requests.push(options);
  return {{ tags: [], items: [{{ bvid: "BV1xx411c7mD" }}] }};
}}
{load_source}
(async () => {{
  await loadD1Browse({{
    kind: "name",
    letter: "A",
    tag: "Alias",
    locale: "zh",
    aliases: [
      {{ tag: "Alias", locale: "zh" }},
      {{ tag: "Alias Extended", locale: "zh" }},
    ],
  }});
  console.log(JSON.stringify({{
    requestCount: requests.length,
    request: requests[0],
    bvid: state.d1BrowseData?.items?.[0]?.bvid,
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

    def test_host_uses_one_indexed_browse_request(self):
        result = self.run_load(
            "static/app.js",
            "function ensurePendingReviewView(",
            "D1_BROWSE_ITEM_LIMIT",
            "D1_BROWSE_TAG_LIMIT",
        )

        self.assertEqual(result["requestCount"], 1)
        self.assertEqual(result["request"]["tag"], "Alias")
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
        self.assertEqual(result["bvid"], "BV1xx411c7mD")


if __name__ == "__main__":
    unittest.main()
