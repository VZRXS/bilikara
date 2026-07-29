from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class SearchResultFrontendTest(unittest.TestCase):
    @staticmethod
    def function_source(source: str, name: str, next_name: str) -> str:
        start = source.index(f"function {name}")
        end = source.index(f"function {next_name}", start)
        return source[start:end]

    def assert_metadata_order(self, source_path: str, *, remote: bool) -> None:
        source = (ROOT / source_path).read_text(encoding="utf-8")
        function_source = self.function_source(
            source,
            "createSearchResultUrlLine",
            "renderSearchResults" if remote else "createSearchResultItem",
        )
        helper_start = source.index("function renderOwnerBadgeLabel")
        helper_end = source.index("\nfunction ", helper_start + 1)
        helper_source = source[helper_start:helper_end]
        script = f"""
const document = {{
  createElement() {{
    return {{
      className: "", textContent: "", children: [], attributes: {{}},
      append(...children) {{ this.children.push(...children); }},
      appendChild(child) {{ this.children.push(child); }},
      replaceChildren(...children) {{ this.children = children; }},
      setAttribute(key, value) {{ this.attributes[key] = String(value); }},
      removeAttribute(key) {{ delete this.attributes[key]; }},
    }};
  }},
}};
function searchResultOwnerName() {{ return "UP"; }}
function searchResultRatingText() {{ return "4.8"; }}
function t(key, values) {{ return values?.name || key; }}
{helper_source}
{function_source}
const line = createSearchResultUrlLine({{ bvid: "BV1TEST", url: "https://example.test" }});
console.log(JSON.stringify({{
  order: line.children.map((child) => child.className),
  ownerChildren: line.children[0].children.map((child) => child.className),
}}));
"""
        completed = subprocess.run(
            ["node", "-e", script],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        expected_order = [
            "search-result-owner owner-badge-label",
            "search-result-rating-text",
        ]
        if not remote:
            expected_order.append("search-result-bvid")
        self.assertEqual(result["order"], expected_order)
        self.assertEqual(result["ownerChildren"], ["owner-badge", "owner-badge-name"])

    def test_host_places_bvid_after_rating(self):
        self.assert_metadata_order("static/app.js", remote=False)

    def test_remote_omits_bvid(self):
        self.assert_metadata_order("static/remote.js", remote=True)

    def test_all_visual_owner_labels_use_the_shared_badge(self):
        host_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        remote_html = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")
        self.assertEqual(host_js.count("renderOwnerBadgeLabel(owner, ownerName);"), 2)
        self.assertEqual(remote_js.count("renderOwnerBadgeLabel(owner, ownerName);"), 2)
        self.assertIn("renderOwnerBadgeLabel(elements.currentOwner, ownerText);", remote_js)
        self.assertIn('class="current-owner-line owner-badge-label hidden"', remote_html)
        for css_path in ("static/styles.css", "static/remote.css"):
            css = (ROOT / css_path).read_text(encoding="utf-8")
            for selector in (".owner-badge-label", ".owner-badge", ".owner-badge-name"):
                self.assertIn(selector, css)
            badge_rule = css.split(".owner-badge {", 1)[1].split("}", 1)[0]
            self.assertNotIn("min-width:", badge_rule)
            self.assertIn("padding-inline:", badge_rule)
            self.assertIn("border: 1.3px solid currentColor;", badge_rule)
            self.assertIn("border-radius: 0.22em;", badge_rule)
            self.assertNotIn("corner-shape:", badge_rule)
            self.assertIn("font-weight: 500;", badge_rule)
            self.assertIn("line-height: 1;", badge_rule)
            self.assertIn("letter-spacing: normal;", badge_rule)
            self.assertIn("transform: translateY(0.08em);", badge_rule)

    def test_up_owner_text_uses_consistent_spacing_and_colons(self):
        i18n = (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"(?i)up主|UP 主:", i18n))
        self.assertIn('"owner.tooltip": "UP 主：{name}"', i18n)


if __name__ == "__main__":
    unittest.main()
