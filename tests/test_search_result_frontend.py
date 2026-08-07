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
        host_css = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        remote_css = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")
        host_badge_rule = host_css.split(".owner-badge {", 1)[1].split("}", 1)[0]
        remote_badge_rule = remote_css.split(".owner-badge {", 1)[1].split("}", 1)[0]
        self.assertIn("transform: translateY(0.08em);", host_badge_rule)
        self.assertIn("transform: translateY(0);", remote_badge_rule)

    def test_up_owner_text_uses_consistent_spacing_and_colons(self):
        i18n = (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"(?i)up主|UP 主:", i18n))
        self.assertIn('"owner.tooltip": "UP 主：{name}"', i18n)

    def test_expanded_search_uses_shared_detail_view_without_refetching(self):
        detail_js = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        host_html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        remote_html = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")

        for html in (host_html, remote_html):
            self.assertIn('href="/song-detail.css"', html)
            self.assertIn('src="/song-detail.js"', html)
        self.assertNotIn("fetch(", detail_js)
        self.assertNotIn("/api/video/preview", detail_js)
        self.assertIn("activeItem = { ...(item || {}) };", detail_js)
        self.assertIn('firstValue(item, ["cover_url", "cover", "pic", "pic_url", "thumbnail"])', detail_js)
        self.assertIn('firstValue(item, ["played_count", "play_count", "play", "view", "views"])', detail_js)
        self.assertIn('firstValue(item, ["rank", "rating", "score"])', detail_js)
        self.assertIn('firstValue(item, ["owner_avatar_url", "owner_avatar", "avatar_url", "face"])', detail_js)
        self.assertNotIn("data-song-detail-owner-id", detail_js)
        self.assertNotIn("data-song-detail-parts", detail_js)
        self.assertNotIn("item?.pages", detail_js)

    def test_detail_metadata_order_and_secure_bilibili_anchor(self):
        source = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        owner = source.index('class="song-detail-owner" data-song-detail-owner')
        bvid = source.index('class="song-detail-bvid hidden" data-song-detail-bvid')
        link = source.index('class="song-detail-bilibili-link hidden" data-song-detail-bilibili-link')
        metrics = source.index('class="song-detail-metrics"')

        self.assertLess(owner, bvid)
        self.assertLess(bvid, link)
        self.assertLess(link, metrics)
        anchor = re.search(r'<a class="song-detail-bilibili-link[\s\S]*?</a>', source)
        self.assertIsNotNone(anchor)
        self.assertIn('target="_blank"', anchor.group(0))
        self.assertIn('rel="noopener noreferrer"', anchor.group(0))

    def test_detail_bvid_normalization_and_canonical_url_are_behavioral(self):
        source = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        helper_source = source[
            source.index("function stringValue"):source.index("function normalizedCoverUrl")
        ]
        script = f"""
{helper_source}
const cases = {{
  direct: normalizedBvid({{ bvid: "bvAb12" }}),
  url: normalizedBvid({{ url: "https://www.bilibili.com/video/bvUrl123?spm_id_from=333" }}),
  resolved: normalizedBvid({{ resolved_url: "https://m.bilibili.com/video/BV9x" }}),
  original: normalizedBvid({{ original_url: "https://bilibili.com/video/bV7Y/" }}),
  invalidDirectDoesNotFallThrough: normalizedBvid({{
    bvid: "av123", url: "https://www.bilibili.com/video/BVvalid"
  }}),
  foreignUrl: normalizedBvid({{ url: "https://example.com/video/BVfake" }}),
  unrelatedId: normalizedBvid({{ id: "BVwrong", aid: "BVwrong2", mid: "BVwrong3" }}),
  shortValid: normalizedBvid({{ bvid: "BV1" }}),
  canonical: canonicalBilibiliUrl({{ bvid: "bvAb12" }}),
  unavailable: canonicalBilibiliUrl({{ url: "https://example.com/video/BVfake" }}),
}};
console.log(JSON.stringify(cases));
"""
        completed = subprocess.run(
            ["node", "-e", script],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            json.loads(completed.stdout),
            {
                "direct": "BVAb12",
                "url": "BVUrl123",
                "resolved": "BV9x",
                "original": "BV7Y",
                "invalidDirectDoesNotFallThrough": "",
                "foreignUrl": "",
                "unrelatedId": "",
                "shortValid": "BV1",
                "canonical": "https://www.bilibili.com/video/BVAb12",
                "unavailable": "",
            },
        )

    def test_detail_bilibili_state_is_hidden_and_cleared_without_a_bvid(self):
        source = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        helper_source = source[
            source.index("function stringValue"):source.index("function normalizedCoverUrl")
        ]
        script = f"""
{helper_source}
function element() {{
  const classes = new Set(["hidden"]);
  return {{
    textContent: "", href: "", attributes: {{}},
    classList: {{
      toggle(name, enabled) {{ enabled ? classes.add(name) : classes.delete(name); }},
      contains(name) {{ return classes.has(name); }},
    }},
    setAttribute(name, value) {{ this.attributes[name] = String(value); }},
    removeAttribute(name) {{
      delete this.attributes[name];
      if (name === "href") this.href = "";
    }},
  }};
}}
const elements = {{ bvid: element(), bilibiliLink: element() }};
const translate = (key) => ({{
  "search.openOnBilibili": "Open on Bilibili",
}})[key];
const firstUrl = renderBilibiliMetadata(elements, {{ bvid: "bvFirst" }}, translate);
const before = {{
  bvidText: elements.bvid.textContent,
  bvidHidden: elements.bvid.classList.contains("hidden"),
  linkText: elements.bilibiliLink.textContent,
  linkHidden: elements.bilibiliLink.classList.contains("hidden"),
  href: elements.bilibiliLink.href,
}};
const secondUrl = renderBilibiliMetadata(elements, {{ url: "https://example.com/not-bilibili" }}, translate);
const after = {{
  bvidText: elements.bvid.textContent,
  bvidHidden: elements.bvid.classList.contains("hidden"),
  linkText: elements.bilibiliLink.textContent,
  linkHidden: elements.bilibiliLink.classList.contains("hidden"),
  href: elements.bilibiliLink.href,
  ariaDisabled: elements.bilibiliLink.attributes["aria-disabled"],
  tabindex: elements.bilibiliLink.attributes.tabindex,
}};
console.log(JSON.stringify({{ firstUrl, secondUrl, before, after }}));
"""
        completed = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, timeout=5, check=False
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            json.loads(completed.stdout),
            {
                "firstUrl": "https://www.bilibili.com/video/BVFirst",
                "secondUrl": "",
                "before": {
                    "bvidText": "BVFirst",
                    "bvidHidden": False,
                    "linkText": "Open on Bilibili",
                    "linkHidden": False,
                    "href": "https://www.bilibili.com/video/BVFirst",
                },
                "after": {
                    "bvidText": "",
                    "bvidHidden": True,
                    "linkText": "",
                    "linkHidden": True,
                    "href": "",
                    "ariaDisabled": "true",
                    "tabindex": "-1",
                },
            },
        )
        close_source = self.function_source(source, "close", "request")
        self.assertIn('activeBilibiliUrl = "";', close_source)
        self.assertIn("renderBilibiliMetadata(elements, null, translate);", close_source)

    def test_host_uses_external_open_callback_and_remote_keeps_native_anchor(self):
        host = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        remote = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        detail = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        host_init_start = host.index("function initSearchDetailController")
        host_init = host[host_init_start:host.index("\nelements.searchResults.addEventListener", host_init_start)]
        remote_init = self.function_source(remote, "initSearchDetailController", "renderSearchModalView")

        self.assertIn("onOpenExternal: openExternalUrl,", host_init)
        self.assertNotIn("onOpenExternal", remote_init)
        self.assertNotIn("/api/", remote_init)
        self.assertIn('event.preventDefault();\n        onOpenExternal(activeBilibiliUrl);', detail)

    def test_detail_bilibili_link_translation_exists_in_all_languages(self):
        translations = json.loads((ROOT / "static" / "i18n.json").read_text(encoding="utf-8"))["languages"]
        expected = {
            "zh": "跳转 B 站",
            "en": "Open on Bilibili",
            "ja": "Bilibiliで開く",
        }
        for language, value in expected.items():
            self.assertEqual(translations[language]["search.openOnBilibili"], value)
            self.assertNotIn("search.detailBvidLabel", translations[language])

    def test_expanded_search_cards_open_details_before_ordering(self):
        host_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")

        self.assertEqual(host_js.count("if (openSearchResultDetail(event,"), 5)
        self.assertEqual(remote_js.count("if (openSearchResultDetail(event,"), 4)
        for source in (host_js, remote_js):
            self.assertIn("const searchResultItemByElement = new WeakMap();", source)
            self.assertIn("searchResultItemByElement.get(card)", source)
            self.assertIn("ownerAvatarFromCachedOwners(", source)
            self.assertIn("detailSource: source", source)
            self.assertIn('container?.closest("#search-modal")', source)

    def test_detail_avatar_prefers_matching_owner_name_over_collaboration_mid(self):
        source = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        helper_source = source[source.index("function stringValue"):source.index("function formatDuration")]
        script = f"""
{helper_source}
const owners = [
  {{ uid: "671767", name: "VZRXS", avatar_url: "vzrxs.jpg" }},
  {{ uid: "3145040", name: "kevinx96", avatar_url: "kevin.jpg" }},
];
console.log(JSON.stringify({{
  collaboration: ownerAvatarFromCachedOwners({{ owner_name: "VZRXS", mid: "3145040" }}, owners),
  matchingUid: ownerAvatarFromCachedOwners({{ owner_name: "kevinx96", mid: "3145040" }}, owners),
  mismatchedUid: ownerAvatarFromCachedOwners({{ owner_name: "someone else", mid: "3145040" }}, owners),
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
        self.assertEqual(
            json.loads(completed.stdout),
            {"collaboration": "vzrxs.jpg", "matchingUid": "kevin.jpg", "mismatchedUid": ""},
        )

    def test_detail_actions_are_busy_guarded_and_close_only_after_success(self):
        detail_js = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        self.assertIn("button.disabled = busy || !activeUrl;", detail_js)
        self.assertIn('button.setAttribute("aria-busy", "true");', detail_js)
        self.assertIn('activeButton.textContent = translate("search.adding");', detail_js)
        self.assertIn("const requestGeneration = generation;", detail_js)
        self.assertIn("const completed = await onRequest(activeUrl, position, activeItem);", detail_js)
        self.assertIn("if (completed === true && requestGeneration === generation)", detail_js)
        self.assertIn("elements.close.addEventListener(\"click\", () => close());", detail_js)

    def test_detail_actions_reuse_host_and_remote_button_styles(self):
        detail_js = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")
        host_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")

        self.assertIn('requestButtonClass: "next-button"', host_js)
        self.assertIn('nextButtonClass: "toolbar-button"', host_js)
        self.assertIn('requestButtonClass: "primary-button"', remote_js)
        self.assertIn('nextButtonClass: "secondary-button"', remote_js)
        self.assertIn("elements.request.classList.add(className)", detail_js)
        self.assertNotIn(".song-detail-actions button:disabled", detail_css)

    def test_detail_cover_fills_mobile_grid_column_on_initial_layout(self):
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")
        cover_rule = detail_css.split(".song-detail-cover {", 1)[1].split("}", 1)[0]

        self.assertIn("width: 100%;", cover_rule)
        self.assertIn("min-width: 0;", cover_rule)
        self.assertIn("aspect-ratio: 16 / 9;", cover_rule)

    def test_detail_cover_fallback_layering_is_behind_image(self):
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")
        img_rule = detail_css.split(".song-detail-cover img {", 1)[1].split("}", 1)[0]
        fallback_rule = detail_css.split(".song-detail-cover-fallback {", 1)[1].split("}", 1)[0]
        duration_rule = detail_css.split(".song-detail-duration {", 1)[1].split("}", 1)[0]

        self.assertIn("z-index: 1;", img_rule)
        self.assertIn("position: relative;", fallback_rule)
        self.assertIn("z-index: 0;", fallback_rule)
        self.assertIn("z-index: 2;", duration_rule)

    def test_detail_motion_matches_rating_and_playback_controls(self):
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")
        remote_css = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")
        expected = "0.2s cubic-bezier(0.16, 1, 0.3, 1)"
        self.assertIn(expected, detail_css)
        self.assertIn(expected, remote_css)
        self.assertIn("transform: scale(0.75);", detail_css)
        self.assertIn("transform: scale(1);", detail_css)
        self.assertIn(".song-detail-view.closing .song-detail-card", detail_css)
        self.assertGreaterEqual(remote_css.count("transform: scale(0.75);"), 2)
        self.assertGreaterEqual(detail_css.count("transform: scale(0.75);"), 2)
        self.assertNotIn("transform: scale(0.5);", remote_css)
        self.assertNotIn("transform: scale(0.5);", detail_css)

    def test_expanded_search_uses_x_close_buttons_and_animated_exit(self):
        host_html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        remote_html = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")
        host_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")

        for html in (host_html, remote_html):
            close_button = re.search(r'<button[^>]+id="search-modal-close"[\s\S]*?</button>', html)
            self.assertIsNotNone(close_button)
            self.assertIn(">×</button>", close_button.group(0))
            self.assertIn('data-i18n-aria-label="common.close"', close_button.group(0))

        self.assertIn('elements.searchModal.classList.add("closing");', host_js)
        self.assertIn('elements.searchModal.classList.add("closing");', remote_js)
        self.assertIn("}, 220);", host_js)
        self.assertIn("}, 220);", remote_js)
        self.assertIn("#search-modal.closing > .selection-modal-card.search-modal-card", detail_css)
        self.assertIn("#search-modal.closing > .remote-search-modal-card", detail_css)
        self.assertIn("animation: song-detail-card-out 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;", detail_css)

    def test_close_button_motion_is_platform_consistent(self):
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")
        host_css = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        remote_css = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")

        self.assertIn(".selection-modal .search-modal-close,\n.selection-modal .song-detail-close", detail_css)
        self.assertIn(".selection-modal .search-modal-close:hover", detail_css)
        self.assertIn("width: 32px;\n  height: 32px;\n  min-height: 32px;", detail_css)
        self.assertIn("box-shadow: none;", detail_css)
        self.assertIn("margin-right: 54px;", detail_css)
        self.assertIn("transition: background 0.2s ease;", detail_css)
        self.assertIn(".remote-search-modal .remote-search-modal-close,\n.remote-search-modal .song-detail-close", detail_css)
        self.assertIn("touch-action: manipulation;", detail_css)
        self.assertIn(".remote-search-modal .remote-search-modal-close:hover", detail_css)
        self.assertNotIn("transform: translateY(-1px);", detail_css)
        for css in (host_css, remote_css):
            self.assertIn("--rating-close-bg: rgba(109, 98, 88, 0.16);", css)
            self.assertIn("--rating-close-hover-bg: rgba(109, 98, 88, 0.28);", css)
        for selector in (".remote-qr-popover-close", ".floating-control-close", ".rating-close"):
            self.assertIn(selector, remote_css)
        self.assertGreaterEqual(remote_css.count("background: var(--rating-close-bg);"), 5)
        self.assertGreaterEqual(remote_css.count("background: var(--rating-close-hover-bg);"), 3)

    def test_mobile_remote_song_detail_close_has_only_minimal_optical_correction(self):
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")
        mobile_css = detail_css.split("@media (max-width: 680px) {", 1)[1].split(
            "@media (prefers-reduced-motion: reduce)", 1
        )[0]
        close_rule = mobile_css.split(".remote-search-modal .song-detail-close {", 1)[1].split("}", 1)[0]

        self.assertIn("padding-bottom: 3px;", close_rule)
        self.assertNotIn("padding-left", close_rule)
        self.assertNotIn("padding-right", close_rule)
        self.assertNotIn("transform", close_rule)
        self.assertNotIn(".selection-modal .song-detail-close", mobile_css)
        self.assertNotIn("translateY", mobile_css)
        self.assertIn(">×</button>", detail_js := (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8"))
        self.assertNotIn("<svg", detail_js)


if __name__ == "__main__":
    unittest.main()
