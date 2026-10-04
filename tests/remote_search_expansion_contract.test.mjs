import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const RemoteSearchExpansionTest = {
async setUpClass() {
let source;
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
source = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.size_tier_source = source.slice(sourceIndex(source, "function syncRemoteRequestPanelSizeTier("), sourceIndex(source, "function syncRemoteSearchModeSelection("));
this.search_source = source.slice(sourceIndex(source, "const canonicalBilikaraSearch ="), sourceIndex(source, "function d1BrowseTitle("));
this.hide_pager_source = source.slice(sourceIndex(source, "function hideRemoteResultPager("), sourceIndex(source, "function renderSearchResultPage("));
this.form_handlers = source.slice(sourceIndex(source, "elements.larkSearchQuery?.addEventListener(\"input\""), sourceIndex(source, "elements.larkSearchResults?.addEventListener(\"click\""));
},
async run_node(body) {
let completed, script;
script = (`
const searchResultItemByElement = new WeakMap();
const remoteResultPagers = new WeakMap();
const window = {}; // Optional field presentation runs in the installed browser test.
` + String(this.hide_pager_source) + `

function mockElement(id) {
  const listeners = new Map();
  return {
    id, value: "", disabled: false, innerHTML: "", children: [],
    classList: {
      values: new Set(["hidden"]),
      add(...names) { names.forEach((name) => this.values.add(name)); },
      remove(...names) { names.forEach((name) => this.values.delete(name)); },
      contains(name) { return this.values.has(name); },
      toggle(name, force) {
        if (force === undefined ? !this.values.has(name) : force) this.values.add(name);
        else this.values.delete(name);
      },
    },
    addEventListener(name, callback) {
      const current = listeners.get(name) || [];
      current.push(callback);
      listeners.set(name, current);
    },
    async dispatch(name) {
      const event = { preventDefault() {}, target: this };
      for (const callback of listeners.get(name) || []) await callback(event);
    },
    setAttribute(name, value) { this[name] = String(value); },
    removeAttribute(name) { delete this[name]; },
  };
}

const elements = {
  larkSearchQuery: mockElement("lark-search-query"),
  larkSearchResults: mockElement("lark-search-results"),
  larkSearchButton: mockElement("lark-search-button"),
  larkSearchMessage: mockElement("lark-search-message"),
  larkSearchForm: mockElement("lark-search-form"),
};

function t(key, params) { return params?.count === undefined ? key : \`\${key}:\${params.count}\`; }
function setLarkSearchMessage(message, isError) {
  elements.larkSearchMessage.textContent = message;
  elements.larkSearchMessage.isError = Boolean(isError);
}
function renderLarkSearchResults(items) {
  elements.larkSearchResults.children = items.length ? items.map((item) => {
    const row = { view: "compact" };
    searchResultItemByElement.set(row, item);
    return row;
  }) : [{ className: "search-empty", textContent: t("search.larkNoResults") }];
  elements.larkSearchResults.classList.remove("hidden");
}

const requests = [];
const resolvers = new Map();
function searchCatalog(query) {
  requests.push(query);
  return new Promise((resolve, reject) => resolvers.set(query, { resolve, reject }));
}

` + String(this.size_tier_source) + `
` + String(this.search_source) + `
` + String(this.form_handlers) + `

(async () => {
  ` + String(body) + `
})().catch((error) => { console.error(error); process.exit(1); });
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_shared_search_has_one_live_owner_and_one_network_request() {
let result;
result = (await this.run_node(`
const item1 = { bvid: "BV1", title: "anime 1" };
const item2 = { bvid: "BV2", title: "anime 2" };
elements.larkSearchQuery.value = "anime";
await elements.larkSearchQuery.dispatch("input");
const searchPromise = elements.larkSearchForm.dispatch("submit");
await elements.larkSearchForm.dispatch("submit"); // Duplicate while pending must not read again.
resolvers.get("anime").resolve({items:[item1, item2]});
await searchPromise;
console.log(JSON.stringify({
  requests,
  canonicalQuery: canonicalBilikaraSearch.query,
  inputQuery: elements.larkSearchQuery.value,
  resultCount: elements.larkSearchResults.children.length,
  firstRowMatches: searchResultItemByElement.get(elements.larkSearchResults.children[0]) === item1,
  buttonDisabled: elements.larkSearchButton.disabled,
}));
`));
assert.deepEqual(result["requests"], ["anime"]);
assert.deepEqual(result["canonicalQuery"], "anime");
assert.deepEqual(result["inputQuery"], "anime");
assert.deepEqual(result["resultCount"], 2);
assert.ok(hasContent(result["firstRowMatches"]));
assert.ok(!hasContent(result["buttonDisabled"]));
},
async test_no_results_appear_only_after_pending_request_resolves_empty() {
let result;
result = (await this.run_node(`
elements.larkSearchQuery.value = "anime";
const searchPromise = elements.larkSearchForm.dispatch("submit");
const pending = {
  message: elements.larkSearchMessage.textContent,
  emptyRows: elements.larkSearchResults.children.filter((row) => row.className === "search-empty").length,
  hidden: elements.larkSearchResults.classList.contains("hidden"),
};
resolvers.get("anime").resolve({items:[]});
await searchPromise;
console.log(JSON.stringify({
  pending,
  settled: {
    message: elements.larkSearchMessage.textContent,
    emptyRows: elements.larkSearchResults.children.filter((row) => row.className === "search-empty").length,
    emptyText: elements.larkSearchResults.children[0]?.textContent,
  },
}));
`));
assert.deepEqual(result["pending"]["message"], "search.larkSearching");
assert.deepEqual(result["pending"]["emptyRows"], 0);
assert.ok(hasContent(result["pending"]["hidden"]));
assert.deepEqual(result["settled"]["message"], "search.larkNoResults");
assert.deepEqual(result["settled"]["emptyRows"], 1);
assert.deepEqual(result["settled"]["emptyText"], "search.larkNoResults");
},
async test_stale_request_completion_does_not_overwrite_newer_state() {
let result;
result = (await this.run_node(`
const itemA = { bvid: "A" };
const itemB = { bvid: "B" };
elements.larkSearchQuery.value = "query A";
const requestA = elements.larkSearchForm.dispatch("submit");
elements.larkSearchQuery.value = "query B";
const requestB = elements.larkSearchForm.dispatch("submit");
resolvers.get("query B").resolve({items:[itemB]});
await requestB;
resolvers.get("query A").resolve({items:[itemA]});
await requestA;
console.log(JSON.stringify({
  canonicalQuery: canonicalBilikaraSearch.query,
  itemBvid: canonicalBilikaraSearch.items[0]?.bvid,
  inputQuery: elements.larkSearchQuery.value,
  requestCount: requests.length,
}));
`));
assert.deepEqual(result["canonicalQuery"], "query B");
assert.deepEqual(result["itemBvid"], "B");
assert.deepEqual(result["inputQuery"], "query B");
assert.deepEqual(result["requestCount"], 2);
}
};
test("RemoteSearchExpansionTest.test_shared_search_has_one_live_owner_and_one_network_request", async () => { const instance = Object.create(RemoteSearchExpansionTest); await instance.setUpClass(); await instance.test_shared_search_has_one_live_owner_and_one_network_request(); });
test("RemoteSearchExpansionTest.test_no_results_appear_only_after_pending_request_resolves_empty", async () => { const instance = Object.create(RemoteSearchExpansionTest); await instance.setUpClass(); await instance.test_no_results_appear_only_after_pending_request_resolves_empty(); });
test("RemoteSearchExpansionTest.test_stale_request_completion_does_not_overwrite_newer_state", async () => { const instance = Object.create(RemoteSearchExpansionTest); await instance.setUpClass(); await instance.test_stale_request_completion_does_not_overwrite_newer_state(); });
