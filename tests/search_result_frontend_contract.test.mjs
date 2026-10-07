import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, splitOnce, sourceIndex, iterableValues, concatenate, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const SearchResultFrontendTest = {
async function_source(source, name, next_name) {
let end, start;
start = sourceIndex(source, ("function " + String(name)));
end = sourceIndex(source, ("function " + String(next_name)), start);
return source.slice(start, end);
},
async assert_metadata_order(source_path, {remote} = {}) {
let completed, expected_order, function_source, helper_end, helper_source, helper_start, result, script, source;
source = readFileSync(path.join(ROOT, source_path), "utf8");
function_source = (await this.function_source(source, "createSearchResultUrlLine", (remote ? "renderSearchResults" : "createSearchResultItem")));
helper_start = sourceIndex(source, "function renderOwnerBadgeLabel");
helper_end = sourceIndex(source, `
function `, concatenate(helper_start, 1));
helper_source = source.slice(helper_start, helper_end);
script = (`
const document = {
  createElement() {
    return {
      className: "", textContent: "", children: [], attributes: {},
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this.attributes[key] = String(value); },
      removeAttribute(key) { delete this.attributes[key]; },
    };
  },
};
function searchResultOwnerName() { return "UP"; }
function searchResultRatingText() { return "4.8"; }
function t(key, values) { return values?.name || key; }
` + String(helper_source) + `
` + String(function_source) + `
const line = createSearchResultUrlLine({ bvid: "BV1TEST", url: "https://example.test" });
console.log(JSON.stringify({
  order: line.children.map((child) => child.className),
  ownerChildren: line.children[0].children.map((child) => child.className),
}));
`);
completed = (await runNative("node", ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
expected_order = ["search-result-owner owner-badge-label", "search-result-rating-text"];
assert.deepEqual(result["order"], expected_order);
assert.deepEqual(result["ownerChildren"], ["owner-badge", "owner-badge-name"]);
},
async run_node(script) {
let completed;
completed = (await runNative("node", ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_host_omits_bvid_from_card_metadata() {
(await this.assert_metadata_order("static/app.js", {remote: false}));
},
async test_empty_cover_ellipsis_is_scoped_to_fallback_text() {
let html, script, styles;
script = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
assert.ok(contains("fallback.className = \"search-result-cover-fallback\"", script));
assert.ok(contains("#host-workspace-request .search-result-cover-fallback", styles));
assert.ok(contains(":is(.request-workspace, .search-card-surface) .search-result-cover-fallback", styles));
html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
assert.ok(contains("id=\"gatcha-candidate-card\" class=\"search-card-surface\"", html));
assert.ok(!contains(".search-result-cover.is-empty span", styles));
},
async test_host_history_icon_button_matches_other_history_actions() {
let css, declaration, history_rule, menu_rule, rule;
css = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
menu_rule = sourceIndex(css, ".menu-content .icon-button {");
history_rule = sourceIndex(css, ".history-actions .icon-button {");
rule = css.slice(history_rule, sourceIndex(css, "}", history_rule));
assert.ok(menu_rule < history_rule);
for (const declaration of iterableValues(["width: 36px;", "height: 36px;", "min-width: 36px;", "min-height: 36px;"])) {
assert.ok(contains(declaration, rule));
}
},
async test_remote_omits_bvid() {
(await this.assert_metadata_order("static/remote.js", {remote: true}));
},
async test_all_visual_owner_labels_use_the_shared_badge() {
let badge_rule, css, css_path, host_css, host_js, remote_css, remote_html, remote_js, selector, source;
host_js = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
remote_js = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
remote_html = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
assert.deepEqual(countOccurrences(host_js, "renderOwnerBadgeLabel(owner, ownerName);"), 1);
assert.deepEqual(countOccurrences(remote_js, "renderOwnerBadgeLabel(owner, ownerName);"), 1);
for (const source of iterableValues([host_js, remote_js])) {
assert.ok(contains("window.BilikaraSongDetail.renderOwnerLabel(owner, activeItem, ownerName, state.followBrowseData?.owners);", source));
assert.ok(contains("link.className = \"rating-link song-detail-bilibili-link\";", source));
assert.ok(contains("link.textContent = t(\"search.openOnBilibili\");", source));
}
assert.ok(contains("renderOwnerBadgeLabel(elements.currentOwner, ownerText);", remote_js));
assert.ok(contains("id=\"current-owner\" class=\"current-owner-line owner-badge-label playback-metadata-text hidden\"", remote_html));
assert.ok(contains("data-playback-metadata-field=\"owner\"", remote_html));
for (const css_path of iterableValues(["static/song-detail.css"])) {
css = readFileSync(path.join(ROOT, css_path), "utf8");
for (const selector of iterableValues([".owner-badge-label", ".owner-badge", ".owner-badge-name"])) {
assert.ok(contains(selector, css));
}
badge_rule = splitOnce(splitOnce(css, ".owner-badge {")[1], "}")[0];
assert.ok(!contains("min-width:", badge_rule));
assert.ok(contains("padding-inline:", badge_rule));
assert.ok(contains("border: 1.3px solid currentColor;", badge_rule));
assert.ok(contains("border-radius: 0.22em;", badge_rule));
assert.ok(!contains("corner-shape:", badge_rule));
assert.ok(contains("font-weight: 500;", badge_rule));
assert.ok(contains("line-height: 1;", badge_rule));
assert.ok(contains("letter-spacing: normal;", badge_rule));
}
host_css = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
remote_css = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
assert.equal(countOccurrences(host_css, ".owner-badge {"), 0);
assert.equal(countOccurrences(remote_css, ".owner-badge {"), 0);
assert.ok(!contains("transform:", badge_rule));
assert.ok(contains("padding-block: 0.12em;", badge_rule));
assert.ok(contains('href="/song-detail.css"', readFileSync(path.join(ROOT, "static/index.html"), "utf8")));
assert.ok(contains('href="/song-detail.css"', remote_html));
},
async test_up_owner_text_uses_consistent_spacing_and_colons() {
let i18n;
i18n = readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8");
assert.equal(i18n.match(new RegExp("up\u4e3b|UP \u4e3b:","i")), null);
assert.ok(contains("\"owner.tooltip\": \"UP 主：{name}\"", i18n));
},
async test_expanded_search_uses_shared_detail_view_without_refetching() {
let detail_js, host_html, html, remote_html;
detail_js = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
host_html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
remote_html = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
for (const html of iterableValues([host_html, remote_html])) {
assert.ok(contains("href=\"/song-detail.css\"", html));
assert.ok(contains("src=\"/song-detail.js\"", html));
}
assert.ok(!contains("fetch(", detail_js));
assert.ok(!contains("/api/video/preview", detail_js));
assert.ok(contains("activeItem = { ...(item || {}) };", detail_js));
assert.ok(contains("firstValue(item, [\"cover_url\", \"cover\", \"pic\", \"pic_url\", \"thumbnail\"])", detail_js));
assert.ok(contains("firstValue(item, [\"played_count\", \"play_count\", \"play\", \"view\", \"views\"])", detail_js));
assert.ok(contains("firstValue(item, [\"rank\", \"rating\", \"score\"])", detail_js));
assert.ok(contains("firstValue(item, [\"owner_avatar_url\", \"owner_avatar\", \"avatar_url\", \"face\"])", detail_js));
assert.ok(!contains("data-song-detail-owner-id", detail_js));
assert.ok(!contains("data-song-detail-parts", detail_js));
assert.ok(!contains("item?.pages", detail_js));
},
async test_detail_metadata_order_and_secure_bilibili_anchor() {
let anchor, bvid, link, metrics, owner, source;
source = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
owner = sourceIndex(source, "class=\"song-detail-owner\" data-song-detail-owner");
bvid = sourceIndex(source, "class=\"song-detail-bvid hidden\" data-song-detail-bvid");
link = sourceIndex(source, "class=\"song-detail-bilibili-link hidden\" data-song-detail-bilibili-link");
metrics = sourceIndex(source, "class=\"song-detail-metrics\"");
assert.ok(owner < bvid);
assert.ok(bvid < link);
assert.ok(link < metrics);
anchor = source.match(new RegExp("<a class=\"song-detail-bilibili-link[\\s\\S]*?</a>",""));
assert.notEqual(anchor, null);
assert.ok(contains("target=\"_blank\"", anchor[0]));
assert.ok(contains("rel=\"noopener noreferrer\"", anchor[0]));
},
async test_detail_bvid_normalization_and_canonical_url_are_behavioral() {
let completed, helper_source, script, source;
source = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
helper_source = source.slice(sourceIndex(source, "function stringValue"), sourceIndex(source, "function normalizedCoverUrl"));
script = (`
` + String(helper_source) + `
const cases = {
  direct: normalizedBvid({ bvid: "bvAb12" }),
  url: normalizedBvid({ url: "https://www.bilibili.com/video/bvUrl123?spm_id_from=333" }),
  resolved: normalizedBvid({ resolved_url: "https://m.bilibili.com/video/BV9x" }),
  original: normalizedBvid({ original_url: "https://bilibili.com/video/bV7Y/" }),
  invalidDirectDoesNotFallThrough: normalizedBvid({
    bvid: "av123", url: "https://www.bilibili.com/video/BVvalid"
  }),
  foreignUrl: normalizedBvid({ url: "https://example.com/video/BVfake" }),
  unrelatedId: normalizedBvid({ id: "BVwrong", aid: "BVwrong2", mid: "BVwrong3" }),
  shortValid: normalizedBvid({ bvid: "BV1" }),
  canonical: canonicalBilibiliUrl({ bvid: "bvAb12" }),
  unavailable: canonicalBilibiliUrl({ url: "https://example.com/video/BVfake" }),
};
console.log(JSON.stringify(cases));
`);
completed = (await runNative("node", ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
assert.deepEqual(JSON.parse(completed.stdout), {["direct"]: "BVAb12", ["url"]: "BVUrl123", ["resolved"]: "BV9x", ["original"]: "BV7Y", ["invalidDirectDoesNotFallThrough"]: "", ["foreignUrl"]: "", ["unrelatedId"]: "", ["shortValid"]: "BV1", ["canonical"]: "https://www.bilibili.com/video/BVAb12", ["unavailable"]: ""});
},
async test_detail_bilibili_state_is_hidden_and_cleared_without_a_bvid() {
let close_source, completed, helper_source, script, source;
source = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
helper_source = source.slice(sourceIndex(source, "function stringValue"), sourceIndex(source, "function normalizedCoverUrl"));
script = (`
` + String(helper_source) + `
function element() {
  const classes = new Set(["hidden"]);
  return {
    textContent: "", href: "", attributes: {},
    classList: {
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) {
      delete this.attributes[name];
      if (name === "href") this.href = "";
    },
  };
}
const elements = { bvid: element(), bilibiliLink: element() };
const translate = (key) => ({
  "search.openOnBilibili": "Open on Bilibili",
})[key];
const firstUrl = renderBilibiliMetadata(elements, { bvid: "bvFirst" }, translate);
const before = {
  bvidText: elements.bvid.textContent,
  bvidHidden: elements.bvid.classList.contains("hidden"),
  linkText: elements.bilibiliLink.textContent,
  linkHidden: elements.bilibiliLink.classList.contains("hidden"),
  href: elements.bilibiliLink.href,
};
const secondUrl = renderBilibiliMetadata(elements, { url: "https://example.com/not-bilibili" }, translate);
const after = {
  bvidText: elements.bvid.textContent,
  bvidHidden: elements.bvid.classList.contains("hidden"),
  linkText: elements.bilibiliLink.textContent,
  linkHidden: elements.bilibiliLink.classList.contains("hidden"),
  href: elements.bilibiliLink.href,
  ariaDisabled: elements.bilibiliLink.attributes["aria-disabled"],
  tabindex: elements.bilibiliLink.attributes.tabindex,
};
console.log(JSON.stringify({ firstUrl, secondUrl, before, after }));
`);
completed = (await runNative("node", ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
assert.deepEqual(JSON.parse(completed.stdout), {["firstUrl"]: "https://www.bilibili.com/video/BVFirst", ["secondUrl"]: "", ["before"]: {["bvidText"]: "BVFirst", ["bvidHidden"]: false, ["linkText"]: "Open on Bilibili", ["linkHidden"]: false, ["href"]: "https://www.bilibili.com/video/BVFirst"}, ["after"]: {["bvidText"]: "", ["bvidHidden"]: true, ["linkText"]: "", ["linkHidden"]: true, ["href"]: "", ["ariaDisabled"]: "true", ["tabindex"]: "-1"}});
close_source = (await this.function_source(source, "close", "request"));
assert.ok(contains("activeBilibiliUrl = \"\";", close_source));
assert.ok(contains("renderBilibiliMetadata(elements, null, translate);", close_source));
},
async test_host_uses_external_open_callback_and_remote_keeps_native_anchor() {
let detail, host, host_init, host_init_start, remote, remote_init;
host = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
remote = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
detail = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
host_init_start = sourceIndex(host, "function initSearchDetailController");
host_init = host.slice(host_init_start, sourceIndex(host, `
elements.searchResults.addEventListener`, host_init_start));
remote_init = (await this.function_source(remote, "initSearchDetailController", "selectedFollowOwner"));
assert.ok(contains("onOpenExternal: openExternalUrl,", host_init));
assert.ok(!contains("onOpenExternal", remote_init));
assert.ok(!contains("/api/", remote_init));
assert.ok(contains(`event.preventDefault();
        onOpenExternal(activeBilibiliUrl);`, detail));
},
async test_detail_bilibili_link_translation_exists_in_all_languages() {
let expected, language, translations, value;
translations = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"))["languages"];
expected = {["zh"]: "跳转 B 站", ["en"]: "Open on Bilibili", ["ja"]: "Bilibiliで開く"};
for (const [language, value] of iterableValues(Object.entries(expected))) {
assert.deepEqual(translations[language]["search.openOnBilibili"], value);
assert.ok(!contains("search.detailBvidLabel", translations[language]));
}
},
async test_direct_workspace_cards_open_details_before_ordering() {
let host_js, remote_js, source;
host_js = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
remote_js = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
assert.deepEqual(countOccurrences(host_js, "if (openSearchResultDetail(event,"), 5);
assert.deepEqual(countOccurrences(remote_js, "if (openSearchResultDetail(event,"), 5);
for (const source of iterableValues([host_js, remote_js])) {
assert.ok(contains("const searchResultItemByElement = new WeakMap();", source));
assert.ok(contains("searchResultItemByElement.get(card)", source));
assert.ok(contains("ownerAvatarFromCachedOwners(", source));
assert.ok(contains("detailSource: source", source));
}
assert.ok(!contains("container?.closest(\"#search-modal\")", host_js));
assert.ok(contains("event.target.closest(\"button[data-url]\")", host_js));
assert.ok(!contains("container?.closest(\"#search-modal\")", remote_js));
assert.ok(contains("requestDetailOwnerForContainer(container)", remote_js));
assert.ok(contains("requestDetailSelections", remote_js));
},
async test_detail_avatar_prefers_matching_owner_name_over_collaboration_mid() {
let completed, helper_source, script, source;
source = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
helper_source = source.slice(sourceIndex(source, "function stringValue"), sourceIndex(source, "function formatDuration"));
script = (`
` + String(helper_source) + `
const owners = [
  { uid: "671767", name: "VZRXS", avatar_url: "vzrxs.jpg" },
  { uid: "3145040", name: "kevinx96", avatar_url: "kevin.jpg" },
];
console.log(JSON.stringify({
  collaboration: ownerAvatarFromCachedOwners({ owner_name: "VZRXS", mid: "3145040" }, owners),
  matchingUid: ownerAvatarFromCachedOwners({ owner_name: "kevinx96", mid: "3145040" }, owners),
  mismatchedUid: ownerAvatarFromCachedOwners({ owner_name: "someone else", mid: "3145040" }, owners),
}));
`);
completed = (await runNative("node", ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
assert.deepEqual(JSON.parse(completed.stdout), {["collaboration"]: "vzrxs.jpg", ["matchingUid"]: "kevin.jpg", ["mismatchedUid"]: ""});
},
async test_bilibili_image_urls_use_secure_transport_without_rewriting_other_hosts() {
let helper_source, result, source;
source = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
helper_source = source.slice(sourceIndex(source, "function stringValue"), sourceIndex(source, "function formatDuration"));
result = (await this.run_node((`
` + String(helper_source) + `
console.log(JSON.stringify({
  protocolRelative: normalizeBilibiliImageUrl("//i0.hdslb.com/bfs/archive/cover.jpg"),
  insecureCover: normalizeBilibiliImageUrl("http://i0.hdslb.com/bfs/archive/cover.jpg?x=1&y=2"),
  secureCover: normalizeBilibiliImageUrl("https://i0.hdslb.com/bfs/archive/cover.jpg"),
  rootDomain: normalizeBilibiliImageUrl("http://hdslb.com/path"),
  thirdParty: normalizeBilibiliImageUrl("http://images.example.test/path"),
  lookalike: normalizeBilibiliImageUrl("http://hdslb.com.evil.test/path"),
  coverField: normalizedCoverUrl({ cover_url: "http://i1.hdslb.com/bfs/archive/a.jpg?q=2" }),
  avatarField: normalizedAvatarUrl({ owner_avatar_url: "http://i2.hdslb.com/bfs/face/b.jpg" }),
}));
`)));
assert.deepEqual(result, {["protocolRelative"]: "https://i0.hdslb.com/bfs/archive/cover.jpg", ["insecureCover"]: "https://i0.hdslb.com/bfs/archive/cover.jpg?x=1&y=2", ["secureCover"]: "https://i0.hdslb.com/bfs/archive/cover.jpg", ["rootDomain"]: "https://hdslb.com/path", ["thirdParty"]: "http://images.example.test/path", ["lookalike"]: "http://hdslb.com.evil.test/path", ["coverField"]: "https://i1.hdslb.com/bfs/archive/a.jpg?q=2", ["avatarField"]: "https://i2.hdslb.com/bfs/face/b.jpg"});
},
async test_search_list_and_expanded_detail_share_image_url_normalization() {
let detail, helper, source, source_path;
detail = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
assert.ok(contains("image.src = coverUrl;", detail));
assert.ok(contains("mark.src = avatarUrl;", detail));
assert.ok(contains("renderOwnerLabel(elements.owner, item,", detail));
assert.ok(contains(`normalizeBilibiliImageUrl(
      firstValue(item`, detail));
for (const source_path of iterableValues(["static/app.js", "static/remote.js"])) {
source = readFileSync(path.join(ROOT, source_path), "utf8");
helper = (await this.function_source(source, "searchResultCoverUrl", "formatCompactCount"));
assert.ok(contains("BilikaraSongDetail?.normalizeBilibiliImageUrl?.(coverUrl)", helper));
assert.ok(!contains("coverUrl.startsWith(\"//\")", helper));
}
},
async test_detail_actions_are_busy_guarded_and_close_only_after_success() {
let detail_js;
detail_js = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
assert.ok(contains("button.disabled = busy || !activeUrl;", detail_js));
assert.ok(contains("button.setAttribute(\"aria-busy\", \"true\");", detail_js));
assert.ok(contains("activeButton.textContent = translate(\"search.adding\");", detail_js));
assert.ok(contains("const requestGeneration = generation;", detail_js));
assert.ok(contains("const completed = await onRequest(activeUrl, position, activeItem);", detail_js));
assert.ok(contains("if (completed === true && requestGeneration === generation)", detail_js));
assert.ok(contains("elements.close.addEventListener(\"click\", () => close());", detail_js));
},
async test_nonexpanded_search_add_success_preserves_host_and_remote_results() {
let host, host_handler, host_result, remote, remote_add, remote_result;
host = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
host_handler = host.slice(sourceIndex(host, "elements.searchResults.addEventListener(\"click\""), sourceIndex(host, "async function handleLarkSearchSubmit", sourceIndex(host, "elements.searchResults.addEventListener(\"click\"")));
host_result = (await this.run_node((`
const listeners = {};
const elements = {
  searchResults: {
    innerHTML: "existing results",
    addEventListener(name, callback) { listeners[name] = callback; },
  },
  searchQuery: { value: "anime" },
};
function openSearchResultDetail() { return false; }
function searchResultRequestTarget() { return { url: "https://example.test/song", button: null, anchor: {} }; }
function anchorPointForEvent() { return { x: 0, y: 0 }; }
async function handleAddByUrl() { return true; }
function hideSearchResults() { elements.searchResults.innerHTML = ""; }
function setSearchMessage() {}
function t(key) { return key; }
` + String(host_handler) + `
(async () => {
  await listeners.click({});
  console.log(JSON.stringify({
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`)));
remote = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
remote_add = remote.slice(sourceIndex(remote, "async function addByUrl"), sourceIndex(remote, "async function confirmGatchaCandidate", sourceIndex(remote, "async function addByUrl")));
remote_result = (await this.run_node((`
const state = { submitting: false, gatchaCandidate: null };
const elements = {
  searchQuery: { value: "anime" },
  searchResults: { innerHTML: "existing results" },
  larkSearchQuery: { value: "database" },
  larkSearchResults: { innerHTML: "existing database results" },
};
function selectedRequesterName() { return "tester"; }
function setMessageForSource() {}
function setAppMessage() {}
function t(key) { return key; }
async function submitAddRequestWithDuplicateConfirm() { return { cancelled: false, data: {} }; }
function applyStateSnapshot() {}
function renderGatchaView() {}
function openBindingSheet() {}
` + String(remote_add) + `
(async () => {
  const completed = await addByUrl("https://example.test/song", "tail", "search");
  console.log(JSON.stringify({
    completed,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`)));
assert.deepEqual(host_result, {["query"]: "anime", ["results"]: "existing results"});
assert.deepEqual(remote_result, {["completed"]: true, ["query"]: "anime", ["results"]: "existing results"});
},
async test_binding_success_preserves_lists_and_closes_only_detail_origins() {
let host, host_confirm, host_result, remote, remote_confirm, remote_result;
host = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
host_confirm = host.slice(sourceIndex(host, "async function confirmBindingModal"), sourceIndex(host, "async function handleAdd", sourceIndex(host, "async function confirmBindingModal")));
host_result = (await this.run_node((`
const state = { data: null, bindingIntent: null };
let detailCloseCount = 0;
let bindingCloseCount = 0;
const searchDetailController = { close(options) {
  if (options?.immediate === true) detailCloseCount += 1;
} };
const elements = {
  bindingModalConfirm: null,
  urlInput: { value: "request URL" },
  searchQuery: { value: "anime" },
  searchResults: { innerHTML: "existing results" },
  searchModal: { open: true },
  gatchaResultView: { classList: { add() {} } },
  gatchaInitView: { classList: { remove() {} } },
  addForm: {},
};
function currentBindingSelection() { return { selectedVideoPage: 1, selectedAudioPages: [2] }; }
function setMessageForSource() {}
function setAppMessage() {}
function setRequestActionMessage() {}
function t(key) { return key; }
function selectedRequesterName() { return "tester"; }
async function submitAddRequest() { return { playlist: [] }; }
function closeBindingModal() { bindingCloseCount += 1; }
function setGatchaMessage() {}
function render() {}
function openBindingModal() {}
function anchorPointForEvent() { return { x: 0, y: 0 }; }
function openConfirm() {}
function duplicateConfirmMessage() { return "duplicate"; }
` + String(host_confirm) + `
(async () => {
  state.bindingIntent = { url: "https://example.test/inline-detail", source: "search",
    preserveInput: true, originatedFromDetail: true };
  await confirmBindingModal();
  const afterInlineDetail = { detailCloseCount, bindingCloseCount, searchModalOpen: elements.searchModal.open };
  state.bindingIntent = { url: "https://example.test/modal-detail", source: "modalSearch",
    preserveInput: true, originatedFromDetail: true };
  await confirmBindingModal();
  const afterExpandedDetail = { detailCloseCount, bindingCloseCount, searchModalOpen: elements.searchModal.open };
  state.bindingIntent = { url: "https://example.test/list", source: "search", preserveInput: true };
  await confirmBindingModal();
  console.log(JSON.stringify({
    afterInlineDetail,
    afterExpandedDetail,
    finalDetailCloseCount: detailCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`)));
remote = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
remote_confirm = remote.slice(sourceIndex(remote, "async function confirmBindingSheet"), sourceIndex(remote, "async function setRemoteAvOffset", sourceIndex(remote, "async function confirmBindingSheet")));
remote_result = (await this.run_node((`
const state = { submitting: false, bindingIntent: null, gatchaCandidate: null };
let detailCloseCount = 0;
let bindingCloseCount = 0;
const searchDetailController = { close(options) {
  if (options?.immediate === true) detailCloseCount += 1;
} };
const elements = {
  bindingSheetConfirm: null,
  urlInput: { value: "request URL" },
  searchQuery: { value: "anime" },
  searchResults: { innerHTML: "existing results" },
};
function currentBindingSelection() { return { selectedVideoPage: 1, selectedAudioPages: [2] }; }
function setMessageForSource() {}
function setAppMessage() {}
function setRequestActionMessage() {}
function t(key) { return key; }
function selectedRequesterName() { return "tester"; }
async function submitAddRequestWithDuplicateConfirm() { return { cancelled: false, data: {} }; }
function applyStateSnapshot() {}
function closeBindingSheet() { bindingCloseCount += 1; }
function renderGatchaView() {}
function openBindingSheet() {}
` + String(remote_confirm) + `
(async () => {
  state.bindingIntent = { url: "https://example.test/detail", source: "uids", clearInput: false };
  await confirmBindingSheet();
  const afterDetail = { detailCloseCount, bindingCloseCount };
  state.bindingIntent = { url: "https://example.test/form", source: "request-form", clearInput: false };
  await confirmBindingSheet();
  console.log(JSON.stringify({
    afterDetail,
    finalDetailCloseCount: detailCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`)));
assert.deepEqual(host_result["afterInlineDetail"], {["detailCloseCount"]: 1, ["bindingCloseCount"]: 1, ["searchModalOpen"]: true});
assert.deepEqual(host_result["afterExpandedDetail"], {["detailCloseCount"]: 2, ["bindingCloseCount"]: 2, ["searchModalOpen"]: true});
assert.deepEqual(host_result["finalDetailCloseCount"], 2);
assert.deepEqual(host_result["query"], "anime");
assert.deepEqual(host_result["results"], "existing results");
assert.deepEqual(remote_result["afterDetail"], {["detailCloseCount"]: 1, ["bindingCloseCount"]: 1});
assert.deepEqual(remote_result["finalDetailCloseCount"], 1);
assert.deepEqual(remote_result["query"], "anime");
assert.deepEqual(remote_result["results"], "existing results");
},
async test_host_detail_manual_binding_success_closes_detail_without_clearing_search() {
let host, host_add, host_confirm, result;
host = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
host_confirm = host.slice(sourceIndex(host, "async function confirmBindingModal"), sourceIndex(host, "async function handleAdd", sourceIndex(host, "async function confirmBindingModal")));
host_add = host.slice(sourceIndex(host, "async function handleAddByUrl"), sourceIndex(host, "async function discardBackup", sourceIndex(host, "async function handleAddByUrl")));
result = (await this.run_node((`
const state = { data: null, bindingIntent: null };
let detailCloseCount = 0;
let bindingCloseCount = 0;
let bindingOpenCount = 0;
let failConfirmation = false;
let validSelection = true;
const searchDetailController = { close(options) {
  if (options?.immediate === true) detailCloseCount += 1;
} };
const elements = {
  bindingModalConfirm: null,
  urlInput: { value: "request URL" },
  searchQuery: { value: "anime" },
  searchResults: { innerHTML: "existing results" },
  searchModal: { open: true },
  gatchaResultView: { classList: { add() {} } },
  gatchaInitView: { classList: { remove() {} } },
  addForm: {},
};
function validatedRequesterNameForAdd() { return "tester"; }
function currentBindingSelection() {
  return validSelection
    ? { selectedVideoPage: 1, selectedAudioPages: [2] }
    : { selectedVideoPage: null, selectedAudioPages: [] };
}
function setMessageForSource() {}
function setAppMessage() {}
function setRequestActionMessage() {}
function t(key) { return key; }
function selectedRequesterName() { return "tester"; }
async function submitAddRequest(_url, _position, options) {
  if (!Number.isInteger(options.selectedVideoPage)) {
    const error = new Error("binding required");
    error.code = "manual_binding_required";
    error.payload = { binding: { pages: [{ page: 1 }, { page: 2 }] } };
    throw error;
  }
  if (failConfirmation) {
    throw new Error("network failure");
  }
  return { playlist: [] };
}
function closeBindingModal() { bindingCloseCount += 1; state.bindingIntent = null; }
function openBindingModal(intent, binding) {
  bindingOpenCount += 1;
  state.bindingIntent = { ...intent, binding };
}
function setGatchaMessage() {}
function render() {}
function anchorPointForEvent() { return { x: 0, y: 0 }; }
function openConfirm() {}
function duplicateConfirmMessage() { return "duplicate"; }
` + String(host_confirm) + `
` + String(host_add) + `
(async () => {
  const inlineCompleted = await handleAddByUrl(
    "https://example.test/inline-detail", "tail", { x: 0, y: 0 }, "search",
    { originatedFromDetail: true },
  );
  const inlinePending = {
    completed: inlineCompleted,
    detailCloseCount,
    bindingOpenCount,
    originTracked: state.bindingIntent?.originatedFromDetail === true,
  };
  await confirmBindingModal();
  const inlineSuccess = {
    detailCloseCount,
    bindingCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
    searchModalOpen: elements.searchModal.open,
  };

  const expandedCompleted = await handleAddByUrl(
    "https://example.test/expanded-detail", "tail", { x: 0, y: 0 }, "modalSearch",
    { originatedFromDetail: true },
  );
  await confirmBindingModal();

  await handleAddByUrl(
    "https://example.test/failing-detail", "tail", { x: 0, y: 0 }, "search",
    { originatedFromDetail: true },
  );
  failConfirmation = true;
  await confirmBindingModal();
  const afterNetworkFailure = {
    detailCloseCount,
    bindingCloseCount,
    bindingStillOpen: Boolean(state.bindingIntent),
  };
  failConfirmation = false;
  validSelection = false;
  await confirmBindingModal();
  console.log(JSON.stringify({
    inlinePending,
    inlineSuccess,
    expandedCompleted,
    expandedSuccess: {
      detailCloseCount,
      bindingCloseCount,
      query: elements.searchQuery.value,
      results: elements.searchResults.innerHTML,
      searchModalOpen: elements.searchModal.open,
    },
    afterNetworkFailure,
    afterValidationFailure: {
      detailCloseCount,
      bindingCloseCount,
      bindingStillOpen: Boolean(state.bindingIntent),
      query: elements.searchQuery.value,
      results: elements.searchResults.innerHTML,
    },
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`)));
assert.deepEqual(result["inlinePending"], {["completed"]: false, ["detailCloseCount"]: 0, ["bindingOpenCount"]: 1, ["originTracked"]: true});
assert.deepEqual(result["inlineSuccess"], {["detailCloseCount"]: 1, ["bindingCloseCount"]: 1, ["query"]: "anime", ["results"]: "existing results", ["searchModalOpen"]: true});
assert.ok(!hasContent(result["expandedCompleted"]));
assert.deepEqual(result["expandedSuccess"], {["detailCloseCount"]: 2, ["bindingCloseCount"]: 2, ["query"]: "anime", ["results"]: "existing results", ["searchModalOpen"]: true});
assert.deepEqual(result["afterNetworkFailure"], {["detailCloseCount"]: 2, ["bindingCloseCount"]: 2, ["bindingStillOpen"]: true});
assert.deepEqual(result["afterValidationFailure"], {["detailCloseCount"]: 2, ["bindingCloseCount"]: 2, ["bindingStillOpen"]: true, ["query"]: "anime", ["results"]: "existing results"});
},
async test_host_detail_direct_success_closes_only_detail_and_preserves_search() {
let host, host_add, result;
host = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
host_add = host.slice(sourceIndex(host, "async function handleAddByUrl"), sourceIndex(host, "async function discardBackup", sourceIndex(host, "async function handleAddByUrl")));
result = (await this.run_node((`
const state = { data: null };
let detailCloseCount = 0;
let renderCount = 0;
const searchDetailController = { close(options) {
  if (options?.immediate === true) detailCloseCount += 1;
} };
const elements = {
  searchQuery: { value: "anime" },
  searchResults: { innerHTML: "existing results" },
  searchModal: { open: true },
  addForm: {},
  historyList: {},
};
function validatedRequesterNameForAdd() { return "tester"; }
function setMessageForSource() {}
function setAppMessage() {}
function setRequestActionMessage() {}
function t(key) { return key; }
async function submitAddRequest() { return { playlist: [] }; }
function render() { renderCount += 1; }
function openBindingModal() {}
function openConfirm() {}
function duplicateConfirmMessage() { return "duplicate"; }
function anchorPointForEvent() { return { x: 0, y: 0 }; }
` + String(host_add) + `
(async () => {
  const inlineCompleted = await handleAddByUrl(
    "https://example.test/inline-detail", "tail", { x: 0, y: 0 }, "search",
    { originatedFromDetail: true },
  );
  const inline = {
    completed: inlineCompleted,
    detailCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
    searchModalOpen: elements.searchModal.open,
  };

  const expandedCompleted = await handleAddByUrl(
    "https://example.test/expanded-detail", "tail", { x: 0, y: 0 }, "modalSearch",
    { originatedFromDetail: true },
  );
  const expanded = {
    completed: expandedCompleted,
    detailCloseCount,
    query: elements.searchQuery.value,
    results: elements.searchResults.innerHTML,
    searchModalOpen: elements.searchModal.open,
  };

  const ordinaryCompleted = await handleAddByUrl(
    "https://example.test/result", "tail", { x: 0, y: 0 }, "search",
  );
  console.log(JSON.stringify({
    inline,
    expanded,
    ordinary: {
      completed: ordinaryCompleted,
      detailCloseCount,
      query: elements.searchQuery.value,
      results: elements.searchResults.innerHTML,
      searchModalOpen: elements.searchModal.open,
    },
    renderCount,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`)));
assert.deepEqual(result["inline"], {["completed"]: true, ["detailCloseCount"]: 1, ["query"]: "anime", ["results"]: "existing results", ["searchModalOpen"]: true});
assert.deepEqual(result["expanded"], {["completed"]: true, ["detailCloseCount"]: 2, ["query"]: "anime", ["results"]: "existing results", ["searchModalOpen"]: true});
assert.deepEqual(result["ordinary"], {["completed"]: true, ["detailCloseCount"]: 2, ["query"]: "anime", ["results"]: "existing results", ["searchModalOpen"]: true});
assert.deepEqual(result["renderCount"], 3);
},
async test_detail_actions_reuse_host_and_remote_button_styles() {
let detail_css, detail_js, host_js, remote_js;
detail_js = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
detail_css = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.css"), "utf8");
host_js = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
remote_js = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
assert.ok(contains("requestButtonClass: \"next-button\"", host_js));
assert.ok(contains("nextButtonClass: \"toolbar-button\"", host_js));
assert.ok(contains("requestButtonClass: \"primary-button\"", remote_js));
assert.ok(contains("nextButtonClass: \"secondary-button\"", remote_js));
assert.ok(contains("elements.request.classList.add(className)", detail_js));
assert.ok(!contains(".song-detail-actions button:disabled", detail_css));
},
async test_detail_cover_fills_mobile_grid_column_on_initial_layout() {
let cover_rule, detail_css;
detail_css = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.css"), "utf8");
cover_rule = splitOnce(splitOnce(detail_css, ".song-detail-cover {")[1], "}")[0];
assert.ok(contains("width: 100%;", cover_rule));
assert.ok(contains("min-width: 0;", cover_rule));
assert.ok(contains("aspect-ratio: 16 / 9;", cover_rule));
},
async test_host_tool_detail_uses_its_container_width_instead_of_viewport_width() {
let card_rule, hero_rule, host_css;
host_css = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
hero_rule = host_css.match(new RegExp("\\.request-workspace \\.song-detail-hero\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("grid-template-columns: minmax(0, 1fr)", hero_rule));
card_rule = host_css.match(new RegExp("\\.request-workspace \\.song-detail-card\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: 100%", card_rule));
assert.ok(contains("min-width: 0", card_rule));
},
async test_detail_cover_fallback_layering_is_behind_image() {
let detail_css, duration_rule, fallback_rule, img_rule;
detail_css = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.css"), "utf8");
img_rule = splitOnce(splitOnce(detail_css, ".song-detail-cover img {")[1], "}")[0];
fallback_rule = splitOnce(splitOnce(detail_css, ".song-detail-cover-fallback {")[1], "}")[0];
duration_rule = splitOnce(splitOnce(detail_css, ".song-detail-duration {")[1], "}")[0];
assert.ok(contains("z-index: 1;", img_rule));
assert.ok(contains("position: relative;", fallback_rule));
assert.ok(contains("z-index: 0;", fallback_rule));
assert.ok(contains("z-index: 2;", duration_rule));
},
async test_detail_motion_matches_rating_and_playback_controls() {
let detail_css, expected, remote_css;
detail_css = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.css"), "utf8");
remote_css = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
expected = "0.2s cubic-bezier(0.16, 1, 0.3, 1)";
assert.ok(contains(expected, detail_css));
assert.ok(contains(expected, remote_css));
assert.ok(contains("transform: scale(0.96);", detail_css));
assert.ok(contains("transform: scale(1);", detail_css));
assert.ok(contains(".song-detail-view.closing .song-detail-card", detail_css));
assert.ok(countOccurrences(remote_css, "transform: scale(0.96);") >= 2);
assert.ok(countOccurrences(detail_css, "transform: scale(0.96);") >= 2);
assert.ok(!contains("transform: scale(0.5);", remote_css));
assert.ok(!contains("transform: scale(0.5);", detail_css));
},
async test_song_detail_uses_x_close_and_retired_remote_modal_is_absent() {
let detail_css, detail_js, host_html, host_js, remote_html, remote_js;
host_html = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
remote_html = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
host_js = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
remote_js = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
detail_css = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.css"), "utf8");
assert.ok(!contains("id=\"search-modal-close\"", host_html));
assert.ok(!contains("id=\"search-modal-close\"", remote_html));
assert.ok(!contains("id=\"search-modal\"", remote_html));
assert.ok(contains("const container = elements.requestWorkspace;", host_js));
assert.ok(!contains("elements.searchModal.classList.add(\"closing\");", host_js));
assert.ok(!contains("elements.searchModal.classList.add(\"closing\");", remote_js));
assert.ok(contains("container: elements.remoteShell", remote_js));
detail_js = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
assert.ok(contains("root.className = \"song-detail-view hidden\";", detail_js));
assert.ok(contains("<svg class=\"close-icon\" viewBox=\"0 0 24 24\"", detail_js));
assert.ok(!contains(">×</button>", detail_js));
assert.ok(contains(".song-detail-view.closing .song-detail-card", detail_css));
assert.ok(!contains("#search-modal", detail_css));
assert.ok(!contains("remote-search-modal", detail_css));
assert.ok(contains("animation: song-detail-card-out 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;", detail_css));
},
async test_close_button_motion_is_platform_consistent() {
let css, detail_css, host_css, remote_css, selector, shared_css, shared_remote_close_rule;
detail_css = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.css"), "utf8");
host_css = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
remote_css = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
assert.ok(contains(`.request-workspace .song-detail-close,
.selection-modal .song-detail-close`, detail_css));
assert.ok(contains(".request-workspace .song-detail-close:hover", detail_css));
assert.ok(contains(`width: 32px;
  height: 32px;
  min-height: 32px;`, detail_css));
assert.ok(contains("box-shadow: none;", detail_css));
assert.ok(!contains("#search-modal-content-placeholder", detail_css));
assert.ok(!contains("transform 180ms cubic-bezier(0.16, 1, 0.3, 1)", detail_css));
assert.ok(contains("background 180ms ease", detail_css));
assert.ok(contains(".remote-shell > .song-detail-view .song-detail-close", detail_css));
assert.ok(contains("touch-action: manipulation;", detail_css));
assert.ok(!contains(".remote-shell > .song-detail-view .song-detail-close:hover", detail_css));
assert.ok(!contains("remote-search-modal", concatenate(detail_css, remote_css)));
assert.ok(!contains("transform: scale(1.04);", detail_css));
assert.ok(!contains(".song-detail-close:active", detail_css));
assert.ok(!contains("transform: translateY(-1px);", detail_css));
shared_css = readFileSync(path.join(path.join(ROOT, "static"), "ui-surfaces.css"), "utf8");
for (const css of iterableValues([host_css, remote_css, detail_css, shared_css])) {
assert.ok(contains("background: var(--btn-secondary-bg);", css));
assert.ok(!contains("--close-control", css));
assert.ok(!contains("--qr-popover-close-bg", css));
assert.ok(!contains("--rating-close-bg:", css));
}
for (const selector of iterableValues([".binding-sheet-close", ".rating-close"])) {
assert.ok(contains(selector, remote_css));
}
shared_remote_close_rule = remote_css.match(new RegExp("\\.binding-sheet-close,\\s*\\.rating-close\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("background: var(--btn-secondary-bg);", shared_remote_close_rule));
assert.ok(contains("transition: none;", shared_remote_close_rule));
},
async test_mobile_remote_song_detail_close_is_svg_without_optical_correction() {
let close_rule, detail_css, detail_js, generic_close_rule, mobile_css;
detail_css = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.css"), "utf8");
mobile_css = splitOnce(splitOnce(detail_css, "@media (max-width: 680px) {")[1], "@media (prefers-reduced-motion: reduce)")[0];
close_rule = splitOnce(splitOnce(mobile_css, ".remote-shell > .song-detail-view .song-detail-close {")[1], "}")[0];
generic_close_rule = splitOnce(splitOnce(mobile_css, ".song-detail-close {")[1], "}")[0];
assert.ok(!contains("font-size", generic_close_rule));
assert.ok(contains("padding: 0;", close_rule));
assert.ok(!contains("padding-bottom", close_rule));
assert.ok(!contains("padding-left", close_rule));
assert.ok(!contains("padding-right", close_rule));
assert.ok(!contains("transform", close_rule));
assert.ok(!contains(".selection-modal .song-detail-close", mobile_css));
assert.ok(!contains("translateY", mobile_css));
detail_js = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.js"), "utf8");
assert.ok(!contains(">×</button>", detail_js));
assert.ok(contains("<svg class=\"close-icon\" viewBox=\"0 0 24 24\"", detail_js));
}
};
test("SearchResultFrontendTest.test_host_omits_bvid_from_card_metadata", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_host_omits_bvid_from_card_metadata(); });
test("SearchResultFrontendTest.test_empty_cover_ellipsis_is_scoped_to_fallback_text", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_empty_cover_ellipsis_is_scoped_to_fallback_text(); });
test("SearchResultFrontendTest.test_host_history_icon_button_matches_other_history_actions", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_host_history_icon_button_matches_other_history_actions(); });
test("SearchResultFrontendTest.test_remote_omits_bvid", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_remote_omits_bvid(); });
test("SearchResultFrontendTest.test_all_visual_owner_labels_use_the_shared_badge", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_all_visual_owner_labels_use_the_shared_badge(); });
test("SearchResultFrontendTest.test_up_owner_text_uses_consistent_spacing_and_colons", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_up_owner_text_uses_consistent_spacing_and_colons(); });
test("SearchResultFrontendTest.test_expanded_search_uses_shared_detail_view_without_refetching", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_expanded_search_uses_shared_detail_view_without_refetching(); });
test("SearchResultFrontendTest.test_detail_metadata_order_and_secure_bilibili_anchor", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_metadata_order_and_secure_bilibili_anchor(); });
test("SearchResultFrontendTest.test_detail_bvid_normalization_and_canonical_url_are_behavioral", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_bvid_normalization_and_canonical_url_are_behavioral(); });
test("SearchResultFrontendTest.test_detail_bilibili_state_is_hidden_and_cleared_without_a_bvid", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_bilibili_state_is_hidden_and_cleared_without_a_bvid(); });
test("SearchResultFrontendTest.test_host_uses_external_open_callback_and_remote_keeps_native_anchor", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_host_uses_external_open_callback_and_remote_keeps_native_anchor(); });
test("SearchResultFrontendTest.test_detail_bilibili_link_translation_exists_in_all_languages", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_bilibili_link_translation_exists_in_all_languages(); });
test("SearchResultFrontendTest.test_direct_workspace_cards_open_details_before_ordering", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_direct_workspace_cards_open_details_before_ordering(); });
test("SearchResultFrontendTest.test_detail_avatar_prefers_matching_owner_name_over_collaboration_mid", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_avatar_prefers_matching_owner_name_over_collaboration_mid(); });
test("SearchResultFrontendTest.test_bilibili_image_urls_use_secure_transport_without_rewriting_other_hosts", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_bilibili_image_urls_use_secure_transport_without_rewriting_other_hosts(); });
test("SearchResultFrontendTest.test_search_list_and_expanded_detail_share_image_url_normalization", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_search_list_and_expanded_detail_share_image_url_normalization(); });
test("SearchResultFrontendTest.test_detail_actions_are_busy_guarded_and_close_only_after_success", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_actions_are_busy_guarded_and_close_only_after_success(); });
test("SearchResultFrontendTest.test_nonexpanded_search_add_success_preserves_host_and_remote_results", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_nonexpanded_search_add_success_preserves_host_and_remote_results(); });
test("SearchResultFrontendTest.test_binding_success_preserves_lists_and_closes_only_detail_origins", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_binding_success_preserves_lists_and_closes_only_detail_origins(); });
test("SearchResultFrontendTest.test_host_detail_manual_binding_success_closes_detail_without_clearing_search", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_host_detail_manual_binding_success_closes_detail_without_clearing_search(); });
test("SearchResultFrontendTest.test_host_detail_direct_success_closes_only_detail_and_preserves_search", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_host_detail_direct_success_closes_only_detail_and_preserves_search(); });
test("SearchResultFrontendTest.test_detail_actions_reuse_host_and_remote_button_styles", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_actions_reuse_host_and_remote_button_styles(); });
test("SearchResultFrontendTest.test_detail_cover_fills_mobile_grid_column_on_initial_layout", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_cover_fills_mobile_grid_column_on_initial_layout(); });
test("SearchResultFrontendTest.test_host_tool_detail_uses_its_container_width_instead_of_viewport_width", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_host_tool_detail_uses_its_container_width_instead_of_viewport_width(); });
test("SearchResultFrontendTest.test_detail_cover_fallback_layering_is_behind_image", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_cover_fallback_layering_is_behind_image(); });
test("SearchResultFrontendTest.test_detail_motion_matches_rating_and_playback_controls", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_detail_motion_matches_rating_and_playback_controls(); });
test("SearchResultFrontendTest.test_song_detail_uses_x_close_and_retired_remote_modal_is_absent", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_song_detail_uses_x_close_and_retired_remote_modal_is_absent(); });
test("SearchResultFrontendTest.test_close_button_motion_is_platform_consistent", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_close_button_motion_is_platform_consistent(); });
test("SearchResultFrontendTest.test_mobile_remote_song_detail_close_is_svg_without_optical_correction", async () => { const instance = Object.create(SearchResultFrontendTest); await instance.test_mobile_remote_song_detail_close_is_svg_without_optical_correction(); });

test('shared owner label renders cached identity without changing the item or accepting a mismatched owner', async () => {
  const source = readFileSync(path.join(ROOT, 'static/song-detail.js'), 'utf8');
  const helpers = source.slice(sourceIndex(source, 'function stringValue'), sourceIndex(source, 'function formatDuration'));
  const result = await checked(process.execPath, ['-e', `
    const document = {createElement: tag => ({tag, className:'', textContent:''})};
    ${helpers}
    const owners = [{uid:'671767',name:'VZRXS',avatar_url:'https://i1.hdslb.com/avatar.jpg'}];
    function render(item) {
      const before = JSON.stringify(item);
      const label = {classList:{add(){}},replaceChildren(...children){this.children=children;}};
      renderOwnerLabel(label,item,item.owner_name,owners);
      return {tag:label.children[0].tag,src:label.children[0].src || '',text:label.children[0].textContent,name:label.children[1].textContent,unchanged:JSON.stringify(item)===before};
    }
    console.log(JSON.stringify([render({owner_name:'VZRXS',owner_mid:3145040}),render({owner_name:'Someone else',owner_mid:671767})]));
  `], root);
  assert.deepEqual(JSON.parse(result.stdout), [
    {tag:'img',src:'https://i1.hdslb.com/avatar.jpg',text:'',name:'VZRXS',unchanged:true},
    {tag:'span',src:'',text:'UP',name:'Someone else',unchanged:true},
  ]);
});
