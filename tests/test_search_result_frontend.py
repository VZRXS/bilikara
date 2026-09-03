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
            encoding="utf-8",
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

    def run_node(self, script: str) -> dict:
        completed = subprocess.run(
            ["node", "-e", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=5,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_host_places_bvid_after_rating(self):
        self.assert_metadata_order("static/app.js", remote=False)

    def test_empty_cover_ellipsis_does_not_clip_rating_stars(self):
        script = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        self.assertIn('fallback.className = "search-result-cover-fallback"', script)
        self.assertIn("#host-workspace-request .search-result-cover-fallback", styles)
        self.assertIn(".request-workspace .search-result-cover-fallback", styles)
        self.assertNotIn(".search-result-cover.is-empty span", styles)

    def test_host_history_icon_button_matches_other_history_actions(self):
        css = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        menu_rule = css.index(".menu-content .icon-button {")
        history_rule = css.index(".history-actions .icon-button {")
        rule = css[history_rule : css.index("}", history_rule)]
        self.assertLess(menu_rule, history_rule)
        for declaration in ("width: 36px;", "height: 36px;", "min-width: 36px;", "min-height: 36px;"):
            self.assertIn(declaration, rule)

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
            encoding="utf-8",
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
            ["node", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=5, check=False
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

    def test_direct_workspace_cards_open_details_before_ordering(self):
        host_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")

        self.assertEqual(host_js.count("if (openSearchResultDetail(event,"), 5)
        self.assertEqual(remote_js.count("if (openSearchResultDetail(event,"), 3)
        for source in (host_js, remote_js):
            self.assertIn("const searchResultItemByElement = new WeakMap();", source)
            self.assertIn("searchResultItemByElement.get(card)", source)
            self.assertIn("ownerAvatarFromCachedOwners(", source)
            self.assertIn("detailSource: source", source)
        self.assertNotIn('container?.closest("#search-modal")', host_js)
        self.assertIn('event.target.closest("button[data-url]")', host_js)
        self.assertIn('container?.closest("#search-modal")', remote_js)

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
            encoding="utf-8",
            timeout=5,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            json.loads(completed.stdout),
            {"collaboration": "vzrxs.jpg", "matchingUid": "kevin.jpg", "mismatchedUid": ""},
        )

    def test_bilibili_image_urls_use_secure_transport_without_rewriting_other_hosts(self):
        source = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        helper_source = source[
            source.index("function stringValue"):source.index("function formatDuration")
        ]
        result = self.run_node(
            f"""
{helper_source}
console.log(JSON.stringify({{
  protocolRelative: normalizeBilibiliImageUrl("//i0.hdslb.com/bfs/archive/cover.jpg"),
  insecureCover: normalizeBilibiliImageUrl("http://i0.hdslb.com/bfs/archive/cover.jpg?x=1&y=2"),
  secureCover: normalizeBilibiliImageUrl("https://i0.hdslb.com/bfs/archive/cover.jpg"),
  rootDomain: normalizeBilibiliImageUrl("http://hdslb.com/path"),
  thirdParty: normalizeBilibiliImageUrl("http://images.example.test/path"),
  lookalike: normalizeBilibiliImageUrl("http://hdslb.com.evil.test/path"),
  coverField: normalizedCoverUrl({{ cover_url: "http://i1.hdslb.com/bfs/archive/a.jpg?q=2" }}),
  avatarField: normalizedAvatarUrl({{ owner_avatar_url: "http://i2.hdslb.com/bfs/face/b.jpg" }}),
}}));
"""
        )
        self.assertEqual(
            result,
            {
                "protocolRelative": "https://i0.hdslb.com/bfs/archive/cover.jpg",
                "insecureCover": "https://i0.hdslb.com/bfs/archive/cover.jpg?x=1&y=2",
                "secureCover": "https://i0.hdslb.com/bfs/archive/cover.jpg",
                "rootDomain": "https://hdslb.com/path",
                "thirdParty": "http://images.example.test/path",
                "lookalike": "http://hdslb.com.evil.test/path",
                "coverField": "https://i1.hdslb.com/bfs/archive/a.jpg?q=2",
                "avatarField": "https://i2.hdslb.com/bfs/face/b.jpg",
            },
        )

    def test_search_list_and_expanded_detail_share_image_url_normalization(self):
        detail = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        self.assertIn("image.src = coverUrl;", detail)
        self.assertIn("elements.ownerAvatar.src = avatarUrl;", detail)
        self.assertIn("normalizeBilibiliImageUrl(\n      firstValue(item", detail)

        for source_path in ("static/app.js", "static/remote.js"):
            source = (ROOT / source_path).read_text(encoding="utf-8")
            helper = self.function_source(source, "searchResultCoverUrl", "formatCompactCount")
            self.assertIn("BilikaraSongDetail?.normalizeBilibiliImageUrl?.(coverUrl)", helper)
            self.assertNotIn('coverUrl.startsWith("//")', helper)

    def test_detail_actions_are_busy_guarded_and_close_only_after_success(self):
        detail_js = (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8")
        self.assertIn("button.disabled = busy || !activeUrl;", detail_js)
        self.assertIn('button.setAttribute("aria-busy", "true");', detail_js)
        self.assertIn('activeButton.textContent = translate("search.adding");', detail_js)
        self.assertIn("const requestGeneration = generation;", detail_js)
        self.assertIn("const completed = await onRequest(activeUrl, position, activeItem);", detail_js)
        self.assertIn("if (completed === true && requestGeneration === generation)", detail_js)
        self.assertIn("elements.close.addEventListener(\"click\", () => close());", detail_js)

    def test_nonexpanded_search_add_success_preserves_host_and_remote_results(self):
        host = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        host_handler = host[
            host.index('elements.searchResults.addEventListener("click"') :
            host.index("async function handleLarkSearchSubmit", host.index('elements.searchResults.addEventListener("click"'))
        ]
        host_result = self.run_node(
            f"""
const listeners = {{}};
const elements = {{
  searchResults: {{
    innerHTML: "existing results",
    addEventListener(name, callback) {{ listeners[name] = callback; }},
  }},
  searchQuery: {{ value: "anime" }},
}};
function openSearchResultDetail() {{ return false; }}
function searchResultRequestTarget() {{ return {{ url: "https://example.test/song", button: null, anchor: {{}} }}; }}
function anchorPointForEvent() {{ return {{ x: 0, y: 0 }}; }}
async function handleAddByUrl() {{ return true; }}
function hideSearchResults() {{ elements.searchResults.innerHTML = ""; }}
function setSearchMessage() {{}}
function t(key) {{ return key; }}
{host_handler}
(async () => {{
  await listeners.click({{}});
  console.log(JSON.stringify({{
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        )

        remote = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        remote_add = remote[
            remote.index("async function addByUrl") :
            remote.index("async function confirmGatchaCandidate", remote.index("async function addByUrl"))
        ]
        remote_result = self.run_node(
            f"""
const state = {{ submitting: false, gatchaCandidate: null }};
const elements = {{
  searchQuery: {{ value: "anime" }},
  searchResults: {{ innerHTML: "existing results" }},
  larkSearchQuery: {{ value: "database" }},
  larkSearchResults: {{ innerHTML: "existing database results" }},
}};
function selectedRequesterName() {{ return "tester"; }}
function setMessageForSource() {{}}
function t(key) {{ return key; }}
async function submitAddRequestWithDuplicateConfirm() {{ return {{ cancelled: false, data: {{}} }}; }}
function applyStateSnapshot() {{}}
function renderGatchaUidView() {{}}
function openBindingSheet() {{}}
{remote_add}
(async () => {{
  const completed = await addByUrl("https://example.test/song", "tail", "search");
  console.log(JSON.stringify({{
    completed,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        )

        self.assertEqual(host_result, {"query": "anime", "results": "existing results"})
        self.assertEqual(
            remote_result,
            {"completed": True, "query": "anime", "results": "existing results"},
        )

    def test_binding_success_preserves_lists_and_closes_only_detail_origins(self):
        host = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        host_confirm = host[
            host.index("async function confirmBindingModal") :
            host.index("async function handleAdd", host.index("async function confirmBindingModal"))
        ]
        host_result = self.run_node(
            f"""
const state = {{ data: null, bindingIntent: null }};
let detailCloseCount = 0;
let bindingCloseCount = 0;
const searchDetailController = {{ close(options) {{
  if (options?.immediate === true) detailCloseCount += 1;
}} }};
const elements = {{
  bindingModalConfirm: null,
  urlInput: {{ value: "request URL" }},
  searchQuery: {{ value: "anime" }},
  searchResults: {{ innerHTML: "existing results" }},
  searchModal: {{ open: true }},
  gatchaResultView: {{ classList: {{ add() {{}} }} }},
  gatchaInitView: {{ classList: {{ remove() {{}} }} }},
  addForm: {{}},
}};
function currentBindingSelection() {{ return {{ selectedVideoPage: 1, selectedAudioPages: [2] }}; }}
function setMessageForSource() {{}}
function setAppMessage() {{}}
function t(key) {{ return key; }}
function selectedRequesterName() {{ return "tester"; }}
async function submitAddRequest() {{ return {{ playlist: [] }}; }}
function closeBindingModal() {{ bindingCloseCount += 1; }}
function setGatchaMessage() {{}}
function render() {{}}
function openBindingModal() {{}}
function anchorPointForEvent() {{ return {{ x: 0, y: 0 }}; }}
function openConfirm() {{}}
function duplicateConfirmMessage() {{ return "duplicate"; }}
{host_confirm}
(async () => {{
  state.bindingIntent = {{ url: "https://example.test/inline-detail", source: "search",
    preserveInput: true, originatedFromDetail: true }};
  await confirmBindingModal();
  const afterInlineDetail = {{ detailCloseCount, bindingCloseCount, searchModalOpen: elements.searchModal.open }};
  state.bindingIntent = {{ url: "https://example.test/modal-detail", source: "modalSearch",
    preserveInput: true, originatedFromDetail: true }};
  await confirmBindingModal();
  const afterExpandedDetail = {{ detailCloseCount, bindingCloseCount, searchModalOpen: elements.searchModal.open }};
  state.bindingIntent = {{ url: "https://example.test/list", source: "search", preserveInput: true }};
  await confirmBindingModal();
  console.log(JSON.stringify({{
    afterInlineDetail,
    afterExpandedDetail,
    finalDetailCloseCount: detailCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        )

        remote = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        remote_confirm = remote[
            remote.index("async function confirmBindingSheet") :
            remote.index("async function setRemoteAvOffset", remote.index("async function confirmBindingSheet"))
        ]
        remote_result = self.run_node(
            f"""
const state = {{ submitting: false, bindingIntent: null, gatchaCandidate: null }};
let detailCloseCount = 0;
let bindingCloseCount = 0;
const searchDetailController = {{ close(options) {{
  if (options?.immediate === true) detailCloseCount += 1;
}} }};
const elements = {{
  bindingSheetConfirm: null,
  urlInput: {{ value: "request URL" }},
  searchQuery: {{ value: "anime" }},
  searchResults: {{ innerHTML: "existing results" }},
  searchModal: {{ open: true }},
}};
function currentBindingSelection() {{ return {{ selectedVideoPage: 1, selectedAudioPages: [2] }}; }}
function setMessageForSource() {{}}
function setAppMessage() {{}}
function t(key) {{ return key; }}
function selectedRequesterName() {{ return "tester"; }}
async function submitAddRequestWithDuplicateConfirm() {{ return {{ cancelled: false, data: {{}} }}; }}
function applyStateSnapshot() {{}}
function closeBindingSheet() {{ bindingCloseCount += 1; }}
function renderGatchaUidView() {{}}
function openBindingSheet() {{}}
{remote_confirm}
(async () => {{
  state.bindingIntent = {{ url: "https://example.test/detail", source: "modalFollow", clearInput: false }};
  await confirmBindingSheet();
  const afterDetail = {{ detailCloseCount, bindingCloseCount, searchModalOpen: elements.searchModal.open }};
  state.bindingIntent = {{ url: "https://example.test/list", source: "search", clearInput: false }};
  await confirmBindingSheet();
  console.log(JSON.stringify({{
    afterDetail,
    finalDetailCloseCount: detailCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        )

        self.assertEqual(
            host_result["afterInlineDetail"],
            {"detailCloseCount": 1, "bindingCloseCount": 1, "searchModalOpen": True},
        )
        self.assertEqual(
            host_result["afterExpandedDetail"],
            {"detailCloseCount": 2, "bindingCloseCount": 2, "searchModalOpen": True},
        )
        self.assertEqual(host_result["finalDetailCloseCount"], 2)
        self.assertEqual(host_result["query"], "anime")
        self.assertEqual(host_result["results"], "existing results")

        self.assertEqual(
            remote_result["afterDetail"],
            {"detailCloseCount": 1, "bindingCloseCount": 1, "searchModalOpen": True},
        )
        self.assertEqual(remote_result["finalDetailCloseCount"], 1)
        self.assertEqual(remote_result["query"], "anime")
        self.assertEqual(remote_result["results"], "existing results")

    def test_host_detail_manual_binding_success_closes_detail_without_clearing_search(self):
        host = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        host_confirm = host[
            host.index("async function confirmBindingModal") :
            host.index("async function handleAdd", host.index("async function confirmBindingModal"))
        ]
        host_add = host[
            host.index("async function handleAddByUrl") :
            host.index("async function discardBackup", host.index("async function handleAddByUrl"))
        ]
        result = self.run_node(
            f"""
const state = {{ data: null, bindingIntent: null }};
let detailCloseCount = 0;
let bindingCloseCount = 0;
let bindingOpenCount = 0;
let failConfirmation = false;
let validSelection = true;
const searchDetailController = {{ close(options) {{
  if (options?.immediate === true) detailCloseCount += 1;
}} }};
const elements = {{
  bindingModalConfirm: null,
  urlInput: {{ value: "request URL" }},
  searchQuery: {{ value: "anime" }},
  searchResults: {{ innerHTML: "existing results" }},
  searchModal: {{ open: true }},
  gatchaResultView: {{ classList: {{ add() {{}} }} }},
  gatchaInitView: {{ classList: {{ remove() {{}} }} }},
  addForm: {{}},
}};
function validatedRequesterNameForAdd() {{ return "tester"; }}
function currentBindingSelection() {{
  return validSelection
    ? {{ selectedVideoPage: 1, selectedAudioPages: [2] }}
    : {{ selectedVideoPage: null, selectedAudioPages: [] }};
}}
function setMessageForSource() {{}}
function setAppMessage() {{}}
function t(key) {{ return key; }}
function selectedRequesterName() {{ return "tester"; }}
async function submitAddRequest(_url, _position, options) {{
  if (!Number.isInteger(options.selectedVideoPage)) {{
    const error = new Error("binding required");
    error.code = "manual_binding_required";
    error.payload = {{ binding: {{ pages: [{{ page: 1 }}, {{ page: 2 }}] }} }};
    throw error;
  }}
  if (failConfirmation) {{
    throw new Error("network failure");
  }}
  return {{ playlist: [] }};
}}
function closeBindingModal() {{ bindingCloseCount += 1; state.bindingIntent = null; }}
function openBindingModal(intent, binding) {{
  bindingOpenCount += 1;
  state.bindingIntent = {{ ...intent, binding }};
}}
function setGatchaMessage() {{}}
function render() {{}}
function anchorPointForEvent() {{ return {{ x: 0, y: 0 }}; }}
function openConfirm() {{}}
function duplicateConfirmMessage() {{ return "duplicate"; }}
{host_confirm}
{host_add}
(async () => {{
  const inlineCompleted = await handleAddByUrl(
    "https://example.test/inline-detail", "tail", {{ x: 0, y: 0 }}, "search",
    {{ originatedFromDetail: true }},
  );
  const inlinePending = {{
    completed: inlineCompleted,
    detailCloseCount,
    bindingOpenCount,
    originTracked: state.bindingIntent?.originatedFromDetail === true,
  }};
  await confirmBindingModal();
  const inlineSuccess = {{
    detailCloseCount,
    bindingCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
    searchModalOpen: elements.searchModal.open,
  }};

  const expandedCompleted = await handleAddByUrl(
    "https://example.test/expanded-detail", "tail", {{ x: 0, y: 0 }}, "modalSearch",
    {{ originatedFromDetail: true }},
  );
  await confirmBindingModal();

  await handleAddByUrl(
    "https://example.test/failing-detail", "tail", {{ x: 0, y: 0 }}, "search",
    {{ originatedFromDetail: true }},
  );
  failConfirmation = true;
  await confirmBindingModal();
  const afterNetworkFailure = {{
    detailCloseCount,
    bindingCloseCount,
    bindingStillOpen: Boolean(state.bindingIntent),
  }};
  failConfirmation = false;
  validSelection = false;
  await confirmBindingModal();
  console.log(JSON.stringify({{
    inlinePending,
    inlineSuccess,
    expandedCompleted,
    expandedSuccess: {{
      detailCloseCount,
      bindingCloseCount,
      query: elements.searchQuery.value,
      results: elements.searchResults.innerHTML,
      searchModalOpen: elements.searchModal.open,
    }},
    afterNetworkFailure,
    afterValidationFailure: {{
      detailCloseCount,
      bindingCloseCount,
      bindingStillOpen: Boolean(state.bindingIntent),
      query: elements.searchQuery.value,
      results: elements.searchResults.innerHTML,
    }},
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        )

        self.assertEqual(
            result["inlinePending"],
            {"completed": False, "detailCloseCount": 0, "bindingOpenCount": 1, "originTracked": True},
        )
        self.assertEqual(
            result["inlineSuccess"],
            {
                "detailCloseCount": 1,
                "bindingCloseCount": 1,
                "query": "anime",
                "results": "existing results",
                "searchModalOpen": True,
            },
        )
        self.assertFalse(result["expandedCompleted"])
        self.assertEqual(
            result["expandedSuccess"],
            {
                "detailCloseCount": 2,
                "bindingCloseCount": 2,
                "query": "anime",
                "results": "existing results",
                "searchModalOpen": True,
            },
        )
        self.assertEqual(
            result["afterNetworkFailure"],
            {"detailCloseCount": 2, "bindingCloseCount": 2, "bindingStillOpen": True},
        )
        self.assertEqual(
            result["afterValidationFailure"],
            {
                "detailCloseCount": 2,
                "bindingCloseCount": 2,
                "bindingStillOpen": True,
                "query": "anime",
                "results": "existing results",
            },
        )

    def test_host_detail_direct_success_closes_only_detail_and_preserves_search(self):
        host = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        host_add = host[
            host.index("async function handleAddByUrl") :
            host.index("async function discardBackup", host.index("async function handleAddByUrl"))
        ]
        result = self.run_node(
            f"""
const state = {{ data: null }};
let detailCloseCount = 0;
let renderCount = 0;
const searchDetailController = {{ close(options) {{
  if (options?.immediate === true) detailCloseCount += 1;
}} }};
const elements = {{
  searchQuery: {{ value: "anime" }},
  searchResults: {{ innerHTML: "existing results" }},
  searchModal: {{ open: true }},
  addForm: {{}},
  historyList: {{}},
}};
function validatedRequesterNameForAdd() {{ return "tester"; }}
function setMessageForSource() {{}}
function setAppMessage() {{}}
function t(key) {{ return key; }}
async function submitAddRequest() {{ return {{ playlist: [] }}; }}
function render() {{ renderCount += 1; }}
function openBindingModal() {{}}
function openConfirm() {{}}
function duplicateConfirmMessage() {{ return "duplicate"; }}
function anchorPointForEvent() {{ return {{ x: 0, y: 0 }}; }}
{host_add}
(async () => {{
  const inlineCompleted = await handleAddByUrl(
    "https://example.test/inline-detail", "tail", {{ x: 0, y: 0 }}, "search",
    {{ originatedFromDetail: true }},
  );
  const inline = {{
    completed: inlineCompleted,
    detailCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
    searchModalOpen: elements.searchModal.open,
  }};

  const expandedCompleted = await handleAddByUrl(
    "https://example.test/expanded-detail", "tail", {{ x: 0, y: 0 }}, "modalSearch",
    {{ originatedFromDetail: true }},
  );
  const expanded = {{
    completed: expandedCompleted,
    detailCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
    searchModalOpen: elements.searchModal.open,
  }};

  const ordinaryCompleted = await handleAddByUrl(
    "https://example.test/result", "tail", {{ x: 0, y: 0 }}, "search",
  );
  console.log(JSON.stringify({{
    inline,
    expanded,
    ordinary: {{
      completed: ordinaryCompleted,
      detailCloseCount,
      query: elements.searchQuery.value,
      results: elements.searchResults.innerHTML,
      searchModalOpen: elements.searchModal.open,
    }},
    renderCount,
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        )

        self.assertEqual(
            result["inline"],
            {
                "completed": True,
                "detailCloseCount": 1,
                "query": "anime",
                "results": "existing results",
                "searchModalOpen": True,
            },
        )
        self.assertEqual(
            result["expanded"],
            {
                "completed": True,
                "detailCloseCount": 2,
                "query": "anime",
                "results": "existing results",
                "searchModalOpen": True,
            },
        )
        self.assertEqual(
            result["ordinary"],
            {
                "completed": True,
                "detailCloseCount": 2,
                "query": "anime",
                "results": "existing results",
                "searchModalOpen": True,
            },
        )
        self.assertEqual(result["renderCount"], 3)


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

    def test_host_tool_detail_uses_its_container_width_instead_of_viewport_width(self):
        host_css = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        hero_rule = re.search(
            r"\.request-workspace \.song-detail-hero\s*\{([^}]*)\}",
            host_css,
        ).group(1)
        self.assertIn("grid-template-columns: minmax(0, 1fr)", hero_rule)
        card_rule = re.search(
            r"\.request-workspace \.song-detail-card\s*\{([^}]*)\}",
            host_css,
        ).group(1)
        self.assertIn("width: 100%", card_rule)
        self.assertIn("min-width: 0", card_rule)

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

    def test_song_detail_and_remote_modal_use_x_close_buttons_and_animated_exit(self):
        host_html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        remote_html = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")
        host_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")

        self.assertNotIn('id="search-modal-close"', host_html)
        close_button = re.search(r'<button[^>]+id="search-modal-close"[\s\S]*?</button>', remote_html)
        self.assertIsNotNone(close_button)
        self.assertIn(">×</button>", close_button.group(0))
        self.assertIn('data-i18n-aria-label="common.close"', close_button.group(0))

        self.assertIn('const container = elements.requestWorkspace;', host_js)
        self.assertNotIn('elements.searchModal.classList.add("closing");', host_js)
        self.assertIn('elements.searchModal.classList.add("closing");', remote_js)
        self.assertIn('root.className = "song-detail-view hidden";', (ROOT / "static" / "song-detail.js").read_text(encoding="utf-8"))
        self.assertIn("}, 220);", remote_js)
        self.assertIn(".song-detail-view.closing .song-detail-card", detail_css)
        self.assertIn("#search-modal.closing > .remote-search-modal-card", detail_css)
        self.assertIn("animation: song-detail-card-out 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;", detail_css)

    def test_close_button_motion_is_platform_consistent(self):
        detail_css = (ROOT / "static" / "song-detail.css").read_text(encoding="utf-8")
        host_css = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        remote_css = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")

        self.assertIn(".request-workspace .song-detail-close,\n.selection-modal .song-detail-close", detail_css)
        self.assertIn(".request-workspace .song-detail-close:hover", detail_css)
        self.assertIn("width: 32px;\n  height: 32px;\n  min-height: 32px;", detail_css)
        self.assertIn("box-shadow: none;", detail_css)
        self.assertNotIn("#search-modal-content-placeholder", detail_css)
        self.assertIn("transform 180ms cubic-bezier(0.16, 1, 0.3, 1)", detail_css)
        self.assertIn("background 180ms ease", detail_css)
        self.assertIn(".remote-search-modal .remote-search-modal-close,\n.remote-search-modal .song-detail-close", detail_css)
        self.assertIn("touch-action: manipulation;", detail_css)
        self.assertIn(".remote-search-modal .remote-search-modal-close:hover", detail_css)
        self.assertIn("transform: scale(1.04);", detail_css)
        self.assertIn("transform: scale(0.96);", detail_css)
        self.assertNotIn("transform: translateY(-1px);", detail_css)
        for css in (host_css, remote_css):
            self.assertIn("--rating-close-bg: rgba(109, 98, 88, 0.16);", css)
            self.assertIn("--rating-close-hover-bg: rgba(109, 98, 88, 0.28);", css)
        for selector in (".remote-qr-popover-close", ".floating-control-close", ".rating-close"):
            self.assertIn(selector, remote_css)
        shared_remote_close_rule = re.search(
            r"\.remote-qr-popover-close,\s*\.remote-search-modal-close,\s*"
            r"\.binding-sheet-close,\s*\.rating-close,\s*"
            r"\.floating-control-close\s*\{([^}]*)\}",
            remote_css,
        ).group(1)
        self.assertIn("background: var(--rating-close-bg);", shared_remote_close_rule)
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
