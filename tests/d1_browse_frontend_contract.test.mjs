import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, sourceIndex, iterableValues, concatenate, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const D1BrowseFrontendTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
},
async run_load(relative_path, end_marker, item_limit, tag_limit, {kind = "name", letter = "A", query = "", tag = "Alias"} = {}) {
let completed, load_source, remote_mode_helper, script, source, start, start_marker;
source = readFileSync(path.join(ROOT, relative_path), "utf8");
load_source = source.slice(sourceIndex(source, "async function loadD1Browse("), sourceIndex(source, end_marker));
remote_mode_helper = "";
if (((relative_path === "static/remote.js"))) {
remote_mode_helper = `
function d1BrowseModeState(kind) {
  return state.d1BrowseModes[kind === "artist" ? "artist" : "name"];
}
`;
for (const start_marker of iterableValues(["function d1BrowseItemKey(", "function mergeBrowseItems("])) {
start = sourceIndex(source, start_marker);
remote_mode_helper += source.slice(start, concatenate(sourceIndex(source, `
}`, start), 2));
}
}
script = (`
const state = {
  d1BrowseKind: "",
  d1BrowseLetter: "",
  d1BrowseTag: "",
  d1BrowseLocale: "",
  d1BrowseQuery: "",
  d1BrowseData: null,
  d1BrowseLoading: false,
  d1BrowseSeq: 0,
  d1BrowseModes: {
    name: { letter: "", tag: "", locale: "", query: "", data: null, loading: false, seq: 0, error: "" },
    artist: { letter: "", tag: "", locale: "", query: "", data: null, loading: false, seq: 0, error: "" },
  },
};
const ` + String(item_limit) + ` = 451;
const ` + String(tag_limit) + ` = 199;
const requests = [];
function renderD1BrowseView() {}
` + String(remote_mode_helper) + `
async function fetchD1Browse(options) {
  requests.push(options);
  return { tags: [], items: [{ bvid: "BV1xx411c7mD" }] };
}
` + String(load_source) + `
(async () => {
  await loadD1Browse({
    kind: ` + String(JSON.stringify(kind)) + `,
    letter: ` + String(JSON.stringify(letter)) + `,
    query: ` + String(JSON.stringify(query)) + `,
    tag: ` + String(JSON.stringify(tag)) + `,
    locale: "zh",
    aliases: [
      { tag: "Alias", locale: "zh" },
      { tag: "Alias Extended", locale: "zh" },
    ],
  });
  const independentMode = state.d1BrowseModes[` + String(JSON.stringify(kind)) + ` === "artist" ? "artist" : "name"];
  console.log(JSON.stringify({
    requestCount: requests.length,
    request: requests[0],
    bvid: independentMode.data?.items?.[0]?.bvid || state.d1BrowseData?.items?.[0]?.bvid,
  }));
})().catch((error) => { console.error(error); process.exit(1); });
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async run_category_fetch(relative_path) {
let completed, fetch_source, script, source;
source = readFileSync(path.join(ROOT, relative_path), "utf8");
fetch_source = source.slice(sourceIndex(source, "function uniqueD1BrowseTags("), sourceIndex(source, "async function fetchGatchaBrowse("));
script = (`
const requests = [];
function categoryBrowseUsesFullFieldSearch() { return false; }
function clientHeaders() { return {}; }
function localizedApiMessage(value) { return value; }
function t(key) { return key; }
async function fetch(url) {
  requests.push(url);
  return {
    ok: true,
    async json() { return { ok: true, data: { items: [] } }; },
  };
}
` + String(fetch_source) + `
(async () => {
  const data = await fetchD1CategoryBrowse({
    tags: [" Alias ", "Alias", "", "Second"],
    query: " query ",
    offset: 5,
    limit: 10,
  });
  console.log(JSON.stringify({ requests, data }));
})().catch((error) => { console.error(error); process.exit(1); });
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_host_uses_one_indexed_browse_request() {
let result;
result = (await this.run_load("static/app.js", "function ensurePendingReviewView(", "D1_BROWSE_ITEM_LIMIT", "D1_BROWSE_TAG_LIMIT"));
assert.deepEqual(result["requestCount"], 1);
assert.deepEqual(result["request"]["tag"], "Alias");
assert.deepEqual(result["request"]["limit"], 451);
assert.deepEqual(result["bvid"], "BV1xx411c7mD");
},
async test_remote_uses_one_indexed_browse_request() {
let result;
result = (await this.run_load("static/remote.js", "function ensureCategoryBrowseView(", "d1BrowseItemLimit", "d1BrowseTagLimit"));
assert.deepEqual(result["requestCount"], 1);
assert.deepEqual(result["request"]["tag"], "Alias");
assert.deepEqual(result["request"]["limit"], 451);
assert.deepEqual(result["bvid"], "BV1xx411c7mD");
},
async test_host_category_browse_deduplicates_tags_without_removed_alias_helper() {
let result;
result = (await this.run_category_fetch("static/app.js"));
assert.deepEqual(result["requests"].length, 1);
assert.deepEqual(countOccurrences(result["requests"][0], "tag45=Alias"), 1);
assert.ok(contains("tag45=Second", result["requests"][0]));
assert.ok(contains("q=query", result["requests"][0]));
},
async test_remote_category_browse_deduplicates_tags_without_removed_alias_helper() {
let result;
result = (await this.run_category_fetch("static/remote.js"));
assert.deepEqual(result["requests"].length, 1);
assert.deepEqual(countOccurrences(result["requests"][0], "tag45=Alias"), 1);
assert.ok(contains("tag45=Second", result["requests"][0]));
assert.ok(contains("q=query", result["requests"][0]));
},
async test_tagless_browse_uses_tag_limit_and_forwards_query_and_letter() {
let cases, end_marker, item_limit, relative_path, result, tag_limit;
cases = [["static/app.js", "function ensurePendingReviewView(", "D1_BROWSE_ITEM_LIMIT", "D1_BROWSE_TAG_LIMIT"], ["static/remote.js", "function ensureCategoryBrowseView(", "d1BrowseItemLimit", "d1BrowseTagLimit"]];
for (const [relative_path, end_marker, item_limit, tag_limit] of iterableValues(cases)) {
{
result = (await this.run_load(relative_path, end_marker, item_limit, tag_limit, {letter: "b", query: "Love Live", tag: ""}));
assert.deepEqual(result["requestCount"], 1);
assert.deepEqual(result["request"]["tag"], "");
assert.deepEqual(result["request"]["letter"], "B");
assert.deepEqual(result["request"]["query"], "Love Live");
assert.deepEqual(result["request"]["limit"], 199);
}
}
},
async test_artist_browse_uses_one_tagged_item_request_on_host_and_remote() {
let cases, end_marker, item_limit, relative_path, result, tag_limit;
cases = [["static/app.js", "function ensurePendingReviewView(", "D1_BROWSE_ITEM_LIMIT", "D1_BROWSE_TAG_LIMIT"], ["static/remote.js", "function ensureCategoryBrowseView(", "d1BrowseItemLimit", "d1BrowseTagLimit"]];
for (const [relative_path, end_marker, item_limit, tag_limit] of iterableValues(cases)) {
{
result = (await this.run_load(relative_path, end_marker, item_limit, tag_limit, {kind: "artist", letter: "C", query: "Singer", tag: "Artist Alias"}));
assert.deepEqual(result["requestCount"], 1);
assert.deepEqual(result["request"]["kind"], "artist");
assert.deepEqual(result["request"]["tag"], "Artist Alias");
assert.deepEqual(result["request"]["letter"], "C");
assert.deepEqual(result["request"]["query"], "Singer");
assert.deepEqual(result["request"]["limit"], 451);
}
}
}
};
test("D1BrowseFrontendTest.test_host_uses_one_indexed_browse_request", async () => { const instance = Object.create(D1BrowseFrontendTest); await instance.setUpClass(); await instance.test_host_uses_one_indexed_browse_request(); });
test("D1BrowseFrontendTest.test_remote_uses_one_indexed_browse_request", async () => { const instance = Object.create(D1BrowseFrontendTest); await instance.setUpClass(); await instance.test_remote_uses_one_indexed_browse_request(); });
test("D1BrowseFrontendTest.test_host_category_browse_deduplicates_tags_without_removed_alias_helper", async () => { const instance = Object.create(D1BrowseFrontendTest); await instance.setUpClass(); await instance.test_host_category_browse_deduplicates_tags_without_removed_alias_helper(); });
test("D1BrowseFrontendTest.test_remote_category_browse_deduplicates_tags_without_removed_alias_helper", async () => { const instance = Object.create(D1BrowseFrontendTest); await instance.setUpClass(); await instance.test_remote_category_browse_deduplicates_tags_without_removed_alias_helper(); });
test("D1BrowseFrontendTest.test_tagless_browse_uses_tag_limit_and_forwards_query_and_letter", async () => { const instance = Object.create(D1BrowseFrontendTest); await instance.setUpClass(); await instance.test_tagless_browse_uses_tag_limit_and_forwards_query_and_letter(); });
test("D1BrowseFrontendTest.test_artist_browse_uses_one_tagged_item_request_on_host_and_remote", async () => { const instance = Object.create(D1BrowseFrontendTest); await instance.setUpClass(); await instance.test_artist_browse_uses_one_tagged_item_request_on_host_and_remote(); });
