import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, splitOnce, sourceIndex, iterableValues } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const RemoteSearchHardeningTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.source = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.css = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
this.cover_source = (await this._slice("function appendSearchResultCoverFallback", "function createSearchResultRow"));
this.size_tier_source = (await this._slice("function syncRemoteRequestPanelSizeTier", "function syncRemoteSearchModeSelection"));
this.render_source = (await this._slice("function renderSearchResultPage", "function appendSearchResultItems"));
this.hide_pager_source = (await this._slice("function hideRemoteResultPager", "function renderSearchResultPage"));
this.sync_source = (await this._slice("function syncBilikaraSearchView", "async function executeCanonicalBilikaraSearch"));
},
async _slice(start, end) {
let start_index;
start_index = sourceIndex(this.source, start);
return this.source.slice(start_index, sourceIndex(this.source, end, start_index));
},
async run_node(script) {
let completed;
completed = (await runNative(this.node, ["-e", (`(async () => {
` + String(script) + `
})().catch((error) => { console.error(error); process.exit(1); });`)], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout.trim().trimEnd().split(/\r?\n/).at((-1)));
},
async test_inline_browse_results_use_document_scroll() {
let declaration, obsolete, pagination_css, result_rule;
pagination_css = readFileSync(path.join(path.join(ROOT, "static"), "result-pagination.css"), "utf8");
result_rule = splitOnce(splitOnce(pagination_css, ".request-panel :is(.search-results, .tag-browser-tags, .follow-up-grid)")[1], "}")[0];
for (const declaration of iterableValues(["max-height: none;", "overflow: visible;", "overscroll-behavior-y: auto;"])) {
assert.ok(contains(declaration, result_rule));
}
for (const obsolete of iterableValues([".remote-search-modal", "body.remote-search-modal-open"])) {
assert.ok(!contains(obsolete, this.css));
}
assert.ok(!contains("-webkit-overflow-scrolling: touch", result_rule));
},
async test_initial_cover_batch_is_eager_and_image_failure_has_fallback() {
let batch, result;
result = (await this.run_node((`
class MockClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  toggle(name, force) {
    if (force === undefined ? !this.values.has(name) : force) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}
class MockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.className = "";
    this.classList = new MockClassList();
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.textContent = "";
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  set src(value) { this.source = value; }
  get src() { return this.source; }
}
const document = { createElement(tagName) { return new MockElement(tagName); } };
function searchResultCoverUrl(item) { return String(item?.cover_url || ""); }
function formatSearchDuration() { return ""; }
function firstSearchResultValue() { return ""; }
function formatCompactCount() { return ""; }
function createSearchResultRatingBadge() { return null; }
function searchResultStatusLabel() { return ""; }
` + String(this.cover_source) + `

const eager = createSearchResultCover({ bvid: "BV-EAGER", cover_url: "https://example.test/eager.jpg" }, { eagerCover: true });
const eagerImage = eager.children[0];
const lazy = createSearchResultCover({ bvid: "BV-LAZY", cover_url: "https://example.test/lazy.jpg" });
const lazyImage = lazy.children[0];
lazyImage.onload();
eagerImage.onerror();
const missing = createSearchResultCover({ bvid: "BV-MISSING" });

console.log(JSON.stringify({
  eagerLoading: eagerImage.loading,
  eagerReferrerPolicy: eagerImage.referrerPolicy,
  eagerState: eager.dataset.coverState,
  eagerFallback: eager.children[0]?.className,
  eagerFallbackText: eager.children[0]?.textContent,
  eagerErrorClass: eager.classList.contains("is-error"),
  lazyLoading: lazyImage.loading,
  lazyState: lazy.dataset.coverState,
  missingState: missing.dataset.coverState,
  missingFallback: missing.children[0]?.className,
}));
`)));
assert.deepEqual(result, {["eagerLoading"]: "eager", ["eagerReferrerPolicy"]: "no-referrer", ["eagerState"]: "error", ["eagerFallback"]: "search-result-cover-fallback", ["eagerFallbackText"]: "Bili", ["eagerErrorClass"]: true, ["lazyLoading"]: "lazy", ["lazyState"]: "loaded", ["missingState"]: "missing", ["missingFallback"]: "search-result-cover-fallback"});
batch = (await this.run_node((`
const expandedSearchEagerCoverCount = 6;
const elements = {};
const rows = [];
const container = {
  _innerHTML: "",
  classList: { remove() {} },
  children: [],
  set innerHTML(value) { this._innerHTML = value; this.children = []; },
  appendChild(child) { this.children.push(child); },
};
function createSearchResultRow(item, options) {
  const row = { id: item.id, eagerCover: options.eagerCover };
  rows.push(row);
  return row;
}
function applyRequestResultSelection() {}
function requestDetailOwnerForContainer() { return "categories"; }
function t(key) { return key; }
const document = { createElement() { return {}; } };
` + String(this.size_tier_source) + `
` + String(this.render_source) + `
renderSearchResultPage(container, Array.from({ length: 8 }, (_, index) => ({ id: index })));
console.log(JSON.stringify({ eager: rows.map((row) => row.eagerCover) }));
`)));
assert.deepEqual(batch["eager"], [true, true, true, true, true, true, false, false]);
},
async test_pending_shared_search_keeps_same_result_container_mounted() {
let result;
result = (await this.run_node((`
class MockClassList {
  constructor(...names) { this.values = new Set(names); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}
class MockResults {
  constructor() {
    this.classList = new MockClassList("hidden");
    this.children = [];
    this._innerHTML = "";
  }
  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) { this.children.push(child); return child; }
}
const sharedResults = new MockResults();
const window = {}; // Optional search-field presentation is exercised in the browser suite.
const elements = {
  larkSearchQuery: { value: "pending query" },
  larkSearchResults: sharedResults,
};
const canonicalBilikaraSearch = {
  query: "pending query",
  items: [],
  message: "searching",
  isError: false,
  hasSearched: true,
  seq: 1,
  loading: true,
};
function setLarkSearchMessage() {}
function t(key) { return key; }
const rows = [];
function createSearchResultRow(item, options) {
  const row = { id: item.id, eagerCover: options.eagerCover };
  rows.push(row);
  return row;
}
const expandedSearchEagerCoverCount = 6;
const document = { body: { classList: new MockClassList() }, createElement() { return {}; } };
function renderLarkSearchResults(items) {
  sharedResults.innerHTML = "";
  sharedResults.classList.remove("hidden");
  items.forEach((item) => sharedResults.appendChild(createSearchResultRow(item, { eagerCover: false })));
}

` + String(this.size_tier_source) + `
` + String(this.render_source) + `
const remoteResultPagers = new WeakMap();
` + String(this.hide_pager_source) + `
` + String(this.sync_source) + `

syncBilikaraSearchView();
const pending = {
  sameContainer: elements.larkSearchResults === sharedResults,
  hidden: sharedResults.classList.contains("hidden"),
  childCount: sharedResults.children.length,
};

canonicalBilikaraSearch.items = Array.from({ length: 8 }, (_, index) => ({ id: index }));
canonicalBilikaraSearch.message = "found";
canonicalBilikaraSearch.loading = false;
syncBilikaraSearchView();
console.log(JSON.stringify({
  pending,
  completed: {
    sameContainer: elements.larkSearchResults === sharedResults,
    hidden: sharedResults.classList.contains("hidden"),
    rowCount: sharedResults.children.length,
    rowIds: sharedResults.children.map((row) => row.id),
  },
}));
`)));
assert.deepEqual(result["pending"], {["sameContainer"]: true, ["hidden"]: true, ["childCount"]: 0});
assert.deepEqual(result["completed"], {["sameContainer"]: true, ["hidden"]: false, ["rowCount"]: 8, ["rowIds"]: Array.from(Array.from({length: 8}, (_, i) => i))});
},
async test_playback_sheet_has_no_drag_or_swipe_handlers() {
let forbidden, sheet_source;
sheet_source = (await this._slice("function openPlaybackSheet", "async function startRemoteSession"));
for (const forbidden of iterableValues(["makeElementDraggable", "touchstart", "touchmove", "touchend", "pointermove", "mousedown", "mousemove"])) {
assert.ok(!contains(forbidden, sheet_source));
}
assert.ok(contains("elements.playbackDock?.addEventListener(\"click\", openPlaybackSheet)", sheet_source));
assert.ok(contains("elements.playbackSheetCollapse?.addEventListener(\"click\"", sheet_source));
assert.ok(contains("elements.playbackSheetBackdrop?.addEventListener(\"click\"", sheet_source));
}
};
test("RemoteSearchHardeningTest.test_inline_browse_results_use_document_scroll", async () => { const instance = Object.create(RemoteSearchHardeningTest); await instance.setUpClass(); await instance.test_inline_browse_results_use_document_scroll(); });
test("RemoteSearchHardeningTest.test_initial_cover_batch_is_eager_and_image_failure_has_fallback", async () => { const instance = Object.create(RemoteSearchHardeningTest); await instance.setUpClass(); await instance.test_initial_cover_batch_is_eager_and_image_failure_has_fallback(); });
test("RemoteSearchHardeningTest.test_pending_shared_search_keeps_same_result_container_mounted", async () => { const instance = Object.create(RemoteSearchHardeningTest); await instance.setUpClass(); await instance.test_pending_shared_search_keeps_same_result_container_mounted(); });
test("RemoteSearchHardeningTest.test_playback_sheet_has_no_drag_or_swipe_handlers", async () => { const instance = Object.create(RemoteSearchHardeningTest); await instance.setUpClass(); await instance.test_playback_sheet_has_no_drag_or_swipe_handlers(); });
