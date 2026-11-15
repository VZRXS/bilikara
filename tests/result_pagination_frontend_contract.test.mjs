import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import {transform as cssTransform} from 'lightningcss';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { concatenate } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const ResultPaginationFrontendTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
},
async run_case(source) {
let result;
result = (await runNative(this.node, ["-e", concatenate(concatenate(`
const assert = require('node:assert/strict');
const { Pages, compactCount, swipeDirection, dotWindow, maximumPage, fittedPageSize } = require('./static/result-pagination.js');
const items = (offset, count) => Array.from({length: count}, (_, i) => ({id: offset + i}));
const initial = (extra = {}) => ({key: 'uploader', items: items(0, 100),
  total: 612, hasMore: true, ...extra});
(async () => {
`, source), `
})().catch(error => { console.error(error); process.exitCode = 1; });
`)], process.env, 10 * 1000, ROOT));
assert.deepEqual(result.status, 0, concatenate(result.stdout, result.stderr));
},
async test_compact_totals_use_local_units_and_carry_rounding_at_boundaries() {
(await this.run_case(`
for (const language of ['zh', 'ja', 'en']) {
  for (const value of [0, 4, 612, 999]) assert.equal(compactCount(value, language), String(value));
  for (const value of [null, -1, 1.5, NaN, Infinity]) assert.equal(compactCount(value, language), '?');
}
for (const language of ['zh', 'ja']) {
  assert.equal(compactCount(1000, language), '1千');
  assert.equal(compactCount(1234, language), '1.2千');
  assert.equal(compactCount(9949, language), '9.9千');
  assert.equal(compactCount(9950, language), '1万');
  assert.equal(compactCount(123456, language), '12.3万');
  assert.equal(compactCount(1000000, language), '100万');
}
assert.equal(compactCount(100000000, 'zh'), '1亿');
assert.equal(compactCount(100000000, 'ja'), '1億');
assert.equal(compactCount(1000000000000, 'zh'), '1万亿');
assert.equal(compactCount(1000000000000, 'ja'), '1兆');
for (const [value, expected] of [[1000,'1k'],[1234,'1.2k'],[12500,'12.5k'],
  [999949,'999.9k'],[999950,'1M'],[1000000,'1M'],[1250000,'1.3M'],[1000000000,'1B']]) {
  assert.equal(compactCount(value, 'en'), expected);
}
`));
},
async test_direct_jump_fetches_beyond_initial_hundred_and_returns_to_cached_page() {
(await this.run_case(`
const calls = [];
const pages = new Pages();
const input = initial({load: async range => {
  calls.push(range);
  return {items: items(range.offset, 6), offset: range.offset,
    matched_count: 612, has_more: true, next_offset: range.offset + 6};
}});
pages.update(input);
assert.equal(pages.pageCount, 102);
await pages.goTo(84);
assert.deepEqual(calls, [{offset: 498, limit: 6}]);
assert.equal(pages.items[0].id, 498);
pages.update(input); // An unrelated SSE render preserves the visible page.
assert.equal(pages.page, 84);
await pages.goTo(2);
assert.equal(pages.items[0].id, 6);
await pages.goTo(84);
assert.equal(calls.length, 1);
`));
},
async test_full_prefetch_batches_keep_adjacent_turns_cached_at_the_twelve_page_limit() {
(await this.run_case(`
const calls = [], pages = new Pages();
pages.update(initial({items:items(0,72),pageSize:6,readSize:72,readAhead:2,prefetch:true,
  load:async range=>{calls.push(range);return {items:items(range.offset,range.limit),
    offset:range.offset,matched_count:612,has_more:true,next_offset:range.offset+range.limit};}}));
const settle = async()=>{while(pages.prefetchPending)await pages.prefetchPending.promise;};
await pages.goTo(40);await settle();
for(const page of [41,42,43,42,41,40,41,42,43,44]) {
  assert.notEqual(pages.peek(page),null,'an adjacent turn stays cached after the full speculative batch');
  await pages.goTo(page);await settle();
  assert.equal(pages.items[0].id,(page-1)*6);
  assert.ok(pages.cache.size<=12,'the cache remains bounded');
}
assert.equal(calls.filter(range=>range.offset===246).length,0,'page 42 is never re-read after its batch was prefetched');
`));
},
async test_small_cards_use_six_rows_and_preserve_the_visible_range_on_resize() {
(await this.run_case(`
const pages = new Pages();
const options = initial({items:items(0, 450), total:450, hasMore:false, pageSize:24});
pages.update(options);
assert.equal(pages.items.length, 24);
assert.equal(pages.pageCount, 19);
assert.equal(pages.peek(2)[0].id, 24);
await pages.goTo(3);
// Explicit two-column/six-row model fixture, not a native bootstrap fallback.
pages.update({...options,pageSize:12});
assert.equal(pages.page, 5);
assert.equal(pages.items[0].id, 48);
assert.equal(pages.items.length, 12);
assert.equal(pages.peek(4)[0].id, 36);
`));
},
async test_three_row_grids_support_odd_column_counts_without_resetting_pages() {
(await this.run_case(`
for (const size of [3, 9, 15, 21]) {
  const pages = new Pages();
  const options = initial({items:items(0, 80), total:80, hasMore:false, pageSize:size});
  pages.update(options);
  assert.equal(pages.pageSize, size);
  await pages.goTo(2);
  pages.update(options);
  assert.equal(pages.page, 2);
  assert.equal(pages.items[0].id, size);
  assert.equal(pages.items.length, size);
}
`));
},
async test_native_panels_fit_complete_rows_and_bound_extreme_or_unmeasured_sizes() {
(await this.run_case(`
assert.equal(fittedPageSize({columns:3,height:485,itemHeight:72,gap:12}),15);
assert.equal(fittedPageSize({columns:2,height:485,itemHeight:72,gap:12}),10);
assert.equal(fittedPageSize({columns:2,height:281,itemHeight:72,gap:12}),6);
assert.equal(fittedPageSize({columns:2,height:240,itemHeight:72,gap:12}),6);
assert.equal(fittedPageSize({columns:2,height:239,itemHeight:72,gap:12}),4);
assert.equal(fittedPageSize({columns:2,height:256,itemHeight:72,gap:12,padding:16}),6);
assert.equal(fittedPageSize({columns:2,height:10,itemHeight:72,gap:12}),2);
assert.equal(fittedPageSize({columns:5,height:100000,itemHeight:72,gap:12}),45);
assert.equal(fittedPageSize({columns:100000,height:100000,itemHeight:72}),48);
for(const options of [{columns:0},{height:0},{height:NaN},{itemHeight:0},{gap:-1},{padding:-1}]) {
  assert.equal(fittedPageSize({columns:3,height:485,itemHeight:72,gap:12,...options}),null);
}
`));
},
async test_native_capacity_changes_preserve_the_visible_anchor_without_fetching_cached_items() {
(await this.run_case(`
let calls=0;
const pages=new Pages();
const options=initial({items:items(0,100),total:100,hasMore:false,
  load:async()=>{calls++;throw new Error('local page must stay cached');}});
for(const size of [2,4,5,8,10,16,20,25,45,48]) {
  pages.update({...options,pageSize:size});
  assert.equal(pages.pageSize,size);
  await pages.goTo(2);
  const anchor=pages.items[0].id;
  const next=size===48?2:size+1;
  pages.update({...options,pageSize:next});
  assert.ok(pages.items.some(item=>item.id===anchor));
}
for(const size of [0,49,1.5,NaN,Infinity]) {
  pages.update({...options,pageSize:size});assert.equal(pages.pageSize,6);
}
assert.equal(calls,0);
`));
},
async test_pending_and_failed_navigation_preserve_current_page_and_allow_retry() {
(await this.run_case(`
let reject, calls = 0;
const pages = new Pages();
pages.update(initial({load: () => { calls++; return new Promise((_, fail) => {reject = fail}); }}));
const pending = pages.goTo(17);
assert.equal(pages.loading, true);
assert.equal(pages.page, 1);
assert.equal(await pages.goTo(18), false);
assert.equal(calls, 1);
reject(new Error('offline'));
await assert.rejects(pending, /offline/);
assert.equal(pages.loading, false);
assert.equal(pages.page, 1);
assert.equal(pages.items[0].id, 0);
pages.load = async () => ({items: items(96, 6), matched_count: 612, has_more: true, next_offset: 102});
assert.equal(await pages.goTo(17), true);
`));
},
async test_replaced_source_ignores_both_late_success_and_failure() {
(await this.run_case(`
for (const fail of [false, true]) {
  let resolve, reject;
  const pages = new Pages();
  pages.update(initial({load: () => new Promise((yes, no) => { resolve = yes; reject = no; })}));
  const pending = pages.goTo(17);
  pages.update(initial({key: 'other', items: items(800, 20), total: 20, hasMore: false}));
  if (fail) reject(new Error('old request failed'));
  else resolve({items: items(96, 6), has_more: false});
  assert.equal(await pending, false);
  assert.equal(pages.page, 1);
  assert.equal(pages.items[0].id, 800);
  assert.equal(pages.loading, false);
}
`));
},
async test_partial_initial_batch_refetches_overlapping_page_without_skipping_items() {
(await this.run_case(`
let requested;
const pages = new Pages();
pages.update(initial({items: items(0, 100), total: null, load: async range => {
  requested = range;
  return {items: items(range.offset, 6), offset: range.offset,
    next_offset: range.offset + 6, has_more: true};
}}));
await pages.goTo(17);
assert.deepEqual(requested, {offset: 96, limit: 6});
assert.deepEqual(pages.items.map(item => item.id), items(96, 6).map(item => item.id));
assert.equal(pages.pageCount, null);
`));
},
async test_limited_results_remain_browsable_after_page_cache_eviction() {
(await this.run_case(`
const pages = new Pages();
pages.update(initial({items: items(0, 452), total: 452, hasMore: false, limited: true}));
for (let page = 1; page <= 76; page++) await pages.goTo(page);
assert.equal(pages.items.length, 2);
assert.equal(pages.canNext, false);
assert.ok(pages.cache.size <= 12);
await pages.goTo(2);
assert.equal(pages.items[0].id, 6);
await assert.rejects(pages.goTo(77), RangeError);
for (const page of [0, -1, 2.5, NaN, Infinity]) await assert.rejects(pages.goTo(page), RangeError);
`));
},
async test_invalid_or_empty_response_does_not_advance_and_terminal_sets_known_total() {
(await this.run_case(`
const pages = new Pages();
pages.update(initial({total: null}));
for (const response of [
  {items: []}, {items: 'invalid'},
  {items: items(96, 6), offset: 0},
  {items: items(96, 6), has_more: true, next_offset: 96},
]) {
  pages.load = async () => response;
  await assert.rejects(pages.goTo(17));
  assert.equal(pages.page, 1);
  assert.equal(pages.items[0].id, 0);
  assert.equal(pages.loading, false);
}
pages.load = async () => ({items: items(96, 3), offset: 96, has_more: false});
await pages.goTo(17);
assert.equal(pages.total, 99);
assert.equal(pages.pageCount, 17);
assert.equal(pages.canNext, false);
await pages.goTo(1);
assert.equal(pages.canNext, true);
`));
},
async test_direction_lock_tolerates_diagonal_drift_but_preserves_vertical_scrolling() {
(await this.run_case(`
assert.equal(swipeDirection(-90, 8), 1);
assert.equal(swipeDirection(90, 8), -1);
assert.equal(swipeDirection(85, 70), -1);
assert.equal(swipeDirection(-90, 160, true), 1);
assert.equal(swipeDirection(90, -160, true), -1);
assert.equal(swipeDirection(40, 0, true), 0);
for (const [dx, dy] of [[-40, 0], [5, -160], [70, 85], [0, 0]]) {
  assert.equal(swipeDirection(dx, dy), 0);
}
`));
},
async test_three_dot_window_highlights_then_shifts_in_both_directions() {
(await this.run_case(`
let start = 1;
for (const [page, expected] of [[1,[1,2,3]],[2,[1,2,3]],[3,[1,2,3]],
  [4,[2,3,4]],[5,[3,4,5]],[4,[3,4,5]],[3,[3,4,5]],[2,[2,3,4]],[1,[1,2,3]],
  [153,[151,152,153]],[50,[50,51,52]]]) {
  const window = dotWindow(page, 153, start);
  assert.deepEqual(window, expected);
  start = window[0];
}
assert.deepEqual(dotWindow(1,1), [1]);
assert.deepEqual(dotWindow(2,2), [1,2]);
assert.deepEqual(dotWindow(500, null), [498,499,500]);
assert.deepEqual(dotWindow(maximumPage, null), [maximumPage-2, maximumPage-1, maximumPage]);
`));
},
async test_shared_reads_only_current_page_and_two_ahead_without_eager_refills() {
(await this.run_case(`
const calls = [];
const pages = new Pages();
pages.update(initial({items: items(0,18), total: null, readAhead: 2, load: async range => {
  calls.push(range);
  return {items: items(range.offset,18), offset: range.offset,
    has_more:true,next_offset:range.offset+18};
}}));
await pages.goTo(2);
await pages.goTo(3);
assert.equal(calls.length, 0);
await pages.goTo(4);
assert.deepEqual(calls, [{offset:18, limit:18}]);
assert.equal(pages.items.length,6);
await pages.goTo(5);
await pages.goTo(6);
assert.equal(calls.length,1);
await pages.goTo(84);
assert.deepEqual(calls[1], {offset:498,limit:18});
await pages.goTo(86);
assert.equal(calls.length,2);
assert.equal(pages.items[0].id,510);
await assert.rejects(pages.goTo(maximumPage+1), RangeError);
`));
},
async test_search_batches_cache_twelve_pages_without_background_reads() {
(await this.run_case(`
const calls = [];
const pages = new Pages();
pages.update(initial({items:items(0,80), total:221, readSize:72, load:async range=>{
  calls.push(range);
  return {items:items(range.offset,72),offset:range.offset,matched_count:221,
    has_more:true,next_offset:range.offset+72};
}}));
await pages.goTo(14);
for(let page=15;page<=25;page++)await pages.goTo(page);
assert.deepEqual(calls,[{offset:78,limit:72}]);
assert.equal(pages.items[0].id,144);
assert.ok(pages.cache.size<=12);
await pages.goTo(14);
assert.equal(calls.length,1);
`));
},
async test_shared_terminal_batch_preserves_short_last_page_and_stops_reading() {
(await this.run_case(`
let calls = 0;
const pages = new Pages();
pages.update(initial({items: items(0,18), total: null, readAhead: 2, load: async range => {
  calls++;
  assert.deepEqual(range, {offset:18,limit:18});
  return {items:items(18,8),offset:18,has_more:false,next_offset:26};
}}));
await pages.goTo(4);
assert.equal(pages.total,26);
assert.equal(pages.pageCount,5);
await pages.goTo(5);
assert.equal(pages.items.length,2);
assert.equal(pages.canNext,false);
await pages.goTo(2);
await pages.goTo(5);
assert.equal(calls,1);
`));
},
async test_prefetch_warms_next_window_and_navigation_shares_pending_read() {
(await this.run_case(`
const calls = [];
let finish;
const pages = new Pages();
pages.update(initial({items:items(0,18), total:null, readAhead:2, prefetch:true,
  load:range => { calls.push(range); return new Promise(resolve => {finish = resolve}); }}));
assert.equal(calls.length,0);
await pages.goTo(2);
assert.deepEqual(calls,[{offset:18,limit:18}]);
assert.equal(pages.loading,false); // Speculation doesn't block the current page.
const navigation = pages.goTo(4);
assert.equal(calls.length,1); // Navigating joins the speculative request.
finish({items:items(18,18),offset:18,has_more:true,next_offset:36});
assert.equal(await navigation,true);
assert.equal(pages.items[0].id,18);
assert.equal(pages.peek(5)[0].id,24);
assert.equal(calls.length,1); // No recursive scan after the prefetch resolves.
`));
},
async test_last_page_warms_backward_search_window_without_per_page_reads() {
(await this.run_case(`
const calls = [], pages = new Pages();
pages.update(initial({items:items(0,80),total:1000,readSize:72,readAhead:2,prefetch:true,
  load:async range=>{
    calls.push(range);
    const length=Math.min(range.limit,1000-range.offset);
    return {items:items(range.offset,length),offset:range.offset,matched_count:1000,
      has_more:range.offset+length<1000,next_offset:range.offset+length};
  }}));
await pages.goTo(pages.lastPage);
if(pages.prefetchPending)await pages.prefetchPending.promise;
assert.equal(calls.length,2); // One jump and one bounded neighboring window.
for(let page=166;page>=159;page--) {
  assert.ok(pages.peek(page),'Reverse swipe preview is already present');
  const turn=pages.goTo(page);
  assert.equal(pages.loading,false);
  await turn;
  assert.equal(pages.items[0].id,(page-1)*6);
}
assert.equal(calls.length,2);
assert.ok(pages.cache.size<=12);
assert.ok(calls.every(call=>call.limit<=80));
`));
},
async test_jump_during_prefetch_still_warms_the_new_neighbors() {
(await this.run_case(`
let finish;
const pages = new Pages();
pages.update(initial({items:items(0,18),total:221,readAhead:2,prefetch:true,
  load:async range=>{
    if(range.offset===18)return new Promise(resolve=>{finish=resolve});
    const length=Math.min(range.limit,221-range.offset);
    return {items:items(range.offset,length),offset:range.offset,matched_count:221,
      has_more:range.offset+length<221,next_offset:range.offset+length};
  }}));
await pages.goTo(2);
const old=pages.prefetchPending.promise;
await pages.goTo(37);
finish({items:items(18,18),offset:18,has_more:true,next_offset:36});
await old;
if(pages.prefetchPending)await pages.prefetchPending.promise;
assert.equal(pages.page,37);
assert.equal(pages.items[0].id,216);
assert.equal(pages.peek(36)[0].id,210);
`));
},
async test_prefetch_failure_is_quiet_bounded_and_stale_results_are_discarded() {
(await this.run_case(`
for (const fail of [false,true]) {
  let finish, reject, calls = 0;
  const pages = new Pages();
  const input = initial({items:items(0,6),total:null,readAhead:2,prefetch:true,
    load:() => {calls++; return new Promise((yes,no) => {finish=yes;reject=no});}});
  pages.update(input);
  const pending = pages.prefetchPending.promise;
  pages.update({...input,key:'new',items:items(800,6),total:6,hasMore:false});
  if (fail) reject(new Error('offline'));
  else finish({items:items(6,18),offset:6,has_more:false,next_offset:24});
  await pending;
  assert.equal(pages.items[0].id,800);
  assert.equal(pages.total,6);
  assert.equal(calls,1);
}
let calls = 0;
const pages = new Pages();
const input = initial({items:items(0,6),total:null,readAhead:2,prefetch:true,
  load:async () => {calls++;throw new Error('offline');}});
pages.update(input);
await pages.prefetchPending.promise;
for(let i=0;i<10;i++) pages.update(input);
assert.equal(calls,1);
assert.equal(pages.loading,false);
assert.equal(pages.page,1);
const hidden = new Pages();
hidden.update({...input,shouldPrefetch:()=>false});
assert.equal(calls,1);
`));
},
async test_real_remote_adapter_preserves_source_filters_counts_and_legacy_limits() {
(await this.run_case(`
const fs = require('node:fs');
const script = fs.readFileSync('static/remote.js', 'utf8');
const begin = script.indexOf('function remoteResultPaginationOptions(');
const end = script.indexOf('\\nfunction renderSearchResultItems(', begin);
const state = {language: 'zh', followBrowseData: {query: 'song', matched_count: 612, has_more: true},
  followBrowseSelectedUid: '42', followBrowseSeq: 5, followBrowseLoading: false,
  favlistBrowseData: {query: 'favorite', matched_count: 214, has_more: true},
  favlistBrowseSelectedFolderId: '7', favlistBrowseSeq: 6, favlistBrowseLoading: false};
const requestDetailOwnerForContainer = owner => owner;
const canonicalBilikaraSearch = {seq: 9, loading: false, query:'song', data:{has_more:true, matched_count:221}};
const localLibrarySearch = {seq:2,loading:false,query:'local song',data:{has_more:true,matched_count:612}};
const searchCatalog = (...args) => args;
const searchGatchaCache = (...args) => args;
const fetchGatchaBrowse = (...args) => args;
const fetchGatchaFavlistBrowse = (...args) => args;
const fetchD1Browse = args => args;
const mode = {letter: 'A', tag: 'Artist', locale: 'ja', query: 'song', seq: 2,
  data: {has_more: true}, loading: false};
const d1BrowseModeState = () => mode;
eval(script.slice(begin, end));
const range = {offset: 498, limit: 6};
const uploader = remoteResultPaginationOptions('uids', items(0, 100), '');
assert.deepEqual(uploader.load(range), ['42', 'song', range]);
assert.equal(uploader.total, 612);
assert.equal(uploader.limited, false);
const favorite = remoteResultPaginationOptions('favorites', items(0, 100), '');
assert.deepEqual(favorite.load(range), ['7', 'favorite', range]);
const artist = remoteResultPaginationOptions('artist', items(0, 450), '');
assert.deepEqual(artist.load(range), {kind: 'artist', letter: 'A', tag: 'Artist', locale: 'ja', query: 'song', ...range});
assert.equal(artist.total, null);
assert.equal(artist.readAhead, 2);
assert.equal(uploader.readAhead, 0);
mode.data = {};
assert.equal(remoteResultPaginationOptions('artist', items(0, 450), '').limited, true);
const shared = remoteResultPaginationOptions('shared', items(0, 80), '');
assert.equal(shared.total, 221);
assert.equal(shared.limited, false);
assert.deepEqual(shared.load(range), ['song', range]);
const local = remoteResultPaginationOptions('local', items(0,18), '');
assert.equal(local.total,612);
assert.deepEqual(local.load(range), ['local song', range]);
canonicalBilikaraSearch.data = {has_more:true};
assert.equal(remoteResultPaginationOptions('shared',items(0,80),'').total,null);
canonicalBilikaraSearch.data = {};
const legacy = remoteResultPaginationOptions('shared',items(0,80),'');
assert.equal(legacy.total,80);
assert.equal(legacy.limited,true);
assert.equal(legacy.load,null);
`));
}
};
test("ResultPaginationFrontendTest.test_compact_totals_use_local_units_and_carry_rounding_at_boundaries", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_compact_totals_use_local_units_and_carry_rounding_at_boundaries(); });
test("ResultPaginationFrontendTest.test_direct_jump_fetches_beyond_initial_hundred_and_returns_to_cached_page", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_direct_jump_fetches_beyond_initial_hundred_and_returns_to_cached_page(); });
test("ResultPaginationFrontendTest.test_full_prefetch_batches_keep_adjacent_turns_cached_at_the_twelve_page_limit", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_full_prefetch_batches_keep_adjacent_turns_cached_at_the_twelve_page_limit(); });
test("ResultPaginationFrontendTest.test_small_cards_use_six_rows_and_preserve_the_visible_range_on_resize", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_small_cards_use_six_rows_and_preserve_the_visible_range_on_resize(); });
test("ResultPaginationFrontendTest.test_three_row_grids_support_odd_column_counts_without_resetting_pages", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_three_row_grids_support_odd_column_counts_without_resetting_pages(); });
test("ResultPaginationFrontendTest.test_native_panels_fit_complete_rows_and_bound_extreme_or_unmeasured_sizes", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_native_panels_fit_complete_rows_and_bound_extreme_or_unmeasured_sizes(); });
test("ResultPaginationFrontendTest.test_native_capacity_changes_preserve_the_visible_anchor_without_fetching_cached_items", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_native_capacity_changes_preserve_the_visible_anchor_without_fetching_cached_items(); });
test("ResultPaginationFrontendTest.test_pending_and_failed_navigation_preserve_current_page_and_allow_retry", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_pending_and_failed_navigation_preserve_current_page_and_allow_retry(); });
test("ResultPaginationFrontendTest.test_replaced_source_ignores_both_late_success_and_failure", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_replaced_source_ignores_both_late_success_and_failure(); });
test("ResultPaginationFrontendTest.test_partial_initial_batch_refetches_overlapping_page_without_skipping_items", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_partial_initial_batch_refetches_overlapping_page_without_skipping_items(); });
test("ResultPaginationFrontendTest.test_limited_results_remain_browsable_after_page_cache_eviction", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_limited_results_remain_browsable_after_page_cache_eviction(); });
test("ResultPaginationFrontendTest.test_invalid_or_empty_response_does_not_advance_and_terminal_sets_known_total", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_invalid_or_empty_response_does_not_advance_and_terminal_sets_known_total(); });
test("ResultPaginationFrontendTest.test_direction_lock_tolerates_diagonal_drift_but_preserves_vertical_scrolling", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_direction_lock_tolerates_diagonal_drift_but_preserves_vertical_scrolling(); });
test("ResultPaginationFrontendTest.test_three_dot_window_highlights_then_shifts_in_both_directions", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_three_dot_window_highlights_then_shifts_in_both_directions(); });
test("ResultPaginationFrontendTest.test_shared_reads_only_current_page_and_two_ahead_without_eager_refills", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_shared_reads_only_current_page_and_two_ahead_without_eager_refills(); });
test("ResultPaginationFrontendTest.test_search_batches_cache_twelve_pages_without_background_reads", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_search_batches_cache_twelve_pages_without_background_reads(); });
test("ResultPaginationFrontendTest.test_shared_terminal_batch_preserves_short_last_page_and_stops_reading", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_shared_terminal_batch_preserves_short_last_page_and_stops_reading(); });
test("ResultPaginationFrontendTest.test_prefetch_warms_next_window_and_navigation_shares_pending_read", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_prefetch_warms_next_window_and_navigation_shares_pending_read(); });
test("ResultPaginationFrontendTest.test_last_page_warms_backward_search_window_without_per_page_reads", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_last_page_warms_backward_search_window_without_per_page_reads(); });
test("ResultPaginationFrontendTest.test_jump_during_prefetch_still_warms_the_new_neighbors", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_jump_during_prefetch_still_warms_the_new_neighbors(); });
test("ResultPaginationFrontendTest.test_prefetch_failure_is_quiet_bounded_and_stale_results_are_discarded", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_prefetch_failure_is_quiet_bounded_and_stale_results_are_discarded(); });
test("ResultPaginationFrontendTest.test_real_remote_adapter_preserves_source_filters_counts_and_legacy_limits", async () => { const instance = Object.create(ResultPaginationFrontendTest); await instance.setUpClass(); await instance.test_real_remote_adapter_preserves_source_filters_counts_and_legacy_limits(); });

test('source refresh retains a distant page, invalidates its cache and rejects retired reads', async () => {
  const instance=Object.create(ResultPaginationFrontendTest);await instance.setUpClass();await instance.run_case(`
const calls=[],errors=[];let release;
const load=async range=>{calls.push(range);return {items:items(range.offset,range.limit),offset:range.offset,matched_count:612,has_more:true,next_offset:range.offset+range.limit};};
const pages=new Pages(()=>{},error=>errors.push(error.message));
const options=initial({positionKey:'uids:42:query',key:'read-1',load});
pages.update(options);await pages.goTo(35);
const oldItems=pages.items;
pages.update({...options,key:'read-2',loading:true});
assert.equal(pages.page,35);assert.equal(pages.loading,true);assert.equal(pages.items,oldItems);
pages.update({...options,key:'read-2',items:items(0,100),load:range=>new Promise(resolve=>{release=()=>resolve({items:items(range.offset,range.limit).map(item=>({...item,fresh:true})),offset:range.offset,matched_count:612,has_more:true,next_offset:range.offset+range.limit});})});
assert.equal(pages.page,35);assert.equal(pages.loading,true);assert.equal(pages.cache.has(35),false);
release();await new Promise(resolve=>setImmediate(resolve));
assert.equal(pages.items[0].id,204);assert.equal(pages.items[0].fresh,true);assert.equal(pages.loading,false);
pages.update({...options,key:'read-3',items:items(0,100),load:()=>new Promise(resolve=>{release=resolve;})});
pages.update({...options,key:'new-query',positionKey:'uids:42:other-query',items:items(0,100)});
release({items:items(204,6),offset:204,matched_count:612,has_more:true,next_offset:210});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(pages.page,1);assert.equal(pages.items[0].id,0);assert.deepEqual(errors,[]);
`);
});

test('source refresh clamps a shorter list and a failed retained-page read never loops on renders', async () => {
  const instance=Object.create(ResultPaginationFrontendTest);await instance.setUpClass();await instance.run_case(`
const errors=[];let reads=0;
const load=async range=>({items:items(range.offset,range.limit),offset:range.offset,matched_count:612,has_more:true,next_offset:range.offset+range.limit});
const pages=new Pages(()=>{},error=>errors.push(error.message));
const options=initial({positionKey:'uids:42',key:1,load});pages.update(options);await pages.goTo(35);
const failed={...options,key:2,items:items(0,100),load:async()=>{reads++;throw new Error('offline');}};
pages.update(failed);await new Promise(resolve=>setImmediate(resolve));
for(let i=0;i<10;i++)pages.update(failed);
assert.equal(reads,1);assert.equal(pages.page,35);assert.equal(pages.loading,false);assert.deepEqual(errors,['offline']);
pages.update({...options,key:3,items:items(0,12),total:12,hasMore:false});
assert.equal(pages.page,2);assert.equal(pages.items[0].id,6);assert.equal(pages.items.length,6);
`);
});

test('button page turns never dim or slide the live result container (IOS-09-11)', () => {
  const source=readFileSync(path.join(ROOT,'static/result-pagination.js'));
  const start=source.indexOf('async function navigate(page, distance = null) {');
  const end=source.indexOf('input.addEventListener("focus", openEditor);', start);
  assert.ok(start>=0&&end>start,'navigate() must stay locatable');
  const navigate=source.slice(start,end);
  // No half-transparent frame: no opacity keyframes and no container animation
  // for button/number navigation; only the swipe settle path may move content.
  assert.doesNotMatch(navigate,/opacity/);
  assert.doesNotMatch(navigate,/animate\(\s*container/);
  assert.match(navigate,/settleSwipe\(distance, -direction \* pageStride\(\), ticket\)/);
  // Every remaining motion goes through animate(), which yields to reduced motion.
  assert.match(source,/function animate\(element, frames, duration = 220\) \{\n\s+if \(reducedMotion\.matches\) return null;/);
  assert.doesNotMatch(source,/opacity:\s*\.5\b|opacity:\s*0\.5\b/);
});

test('repeated capacity changes and source reordering retain the same record [IOS-09-10]', async () => {
  const instance=Object.create(ResultPaginationFrontendTest);await instance.setUpClass();await instance.run_case(`
const pages=new Pages();
const source=items(0,60),size=fittedPageSize({columns:3,height:322,itemHeight:72,gap:10,padding:4});
const options=initial({items:source,total:60,hasMore:false,pageSize:size,positionKey:'owners',itemKey:item=>item.id});
pages.update(options);await pages.goTo(3);
for(const size of [48,3,30,6,18,12]) {
  pages.update({...options,pageSize:size});
  assert.ok(pages.items.some(item=>item.id===24),'capacity cycles retain the original record');
}
const reordered=[...source].reverse();
pages.update({...options,items:reordered});
assert.ok(pages.items.some(item=>item.id===24),'sorting retains record identity');
await pages.goTo(1);
pages.update({...options,items:reordered,pageSize:3});
assert.ok(pages.items.some(item=>item.id===59),'explicit navigation chooses a new anchor');
pages.update({...options,key:'other',positionKey:'other',items:items(100,60),pageSize:3});
assert.equal(pages.items[0].id,100,'changing the source resets its anchor');
`);
});

test('Host and Remote share one padded pager slot and disjoint arrow boxes [B2-G1-G2]', () => {
  const css=readFileSync(path.join(ROOT,'static/result-pagination.css'),'utf8');
  assert.deepEqual([...css.matchAll(/--host-result-pager-block-size:\s*([^;]+);/g)].map(match=>match[1]),['52px']);
  const slot=css.match(/\n\.result-pager\s*\{([^}]+)\}/)[1];
  assert.match(slot,/height: var\(--host-result-pager-block-size\)/);
  assert.match(slot,/box-sizing: border-box/);
  assert.match(slot,/padding-block: 4px/);
  assert.doesNotMatch(css,/\.source-frame-footer\s*>\s*\.host-result-pager/);
  const arrows=css.match(/\.result-pager \[data-page-action\]\s*\{([^}]+)\}/)[1];
  assert.match(arrows,/width: 44px/);
  assert.match(arrows,/min-width: 44px/);
  assert.match(arrows,/flex: 0 0 44px/);
  assert.doesNotMatch(arrows,/position: absolute|margin:\s*-/);
  assert.match(css,/@media \(max-width: 374px\)[\s\S]*\[data-page-action="first"\][\s\S]*\[data-page-action="last"\][^}]*display: none/);
  assert.match(css,/\.category-browser-home\s*\{\s*padding-bottom: 0/);
});

test('source capacity admits a complete fourth row at the measured boundary [B2-G7]', async () => {
  const instance=Object.create(ResultPaginationFrontendTest);await instance.setUpClass();await instance.run_case(`
const geometry={columns:3,itemHeight:72,gap:10,padding:4};
assert.equal(fittedPageSize({...geometry,height:321}),9);
assert.equal(fittedPageSize({...geometry,height:322}),12);
// Available content height is measured after the Request parent's gaps;
// these boundaries do not assume any fixed toolbar or list-to-tools gap.
assert.equal(fittedPageSize({...geometry,height:403}),12);
assert.equal(fittedPageSize({...geometry,height:404}),15);
`);
});


test('panel capacity retains its first commit and follows current geometry [B2-G10-R1-G9-G11]', async () => {
  const instance=Object.create(ResultPaginationFrontendTest);await instance.setUpClass();await instance.run_case(String.raw`
const fs=require('node:fs');
const source=fs.readFileSync('static/result-pagination.js','utf8').replace(/\r\n/g,'\n');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);};
// Exercise the production controller with measured inputs; WSL verifies CSS.
const fitting=section('    function measureCapacity(', '    function layout()');
const publishing=section('    function publishPageSize()', '    function commitPaint(');
const updating=section('      update(value) {', '      localize(language) {');
const hiding=section('      hide() {', '\n    };\n  }');
function fixture(minimumRows=1) {
  let options={},capacityReady=false,fittedGeometry=null;
  let layoutFrame=null,idleTimer=null,visibleDots=[],renderedItems=null,observedItem=null;
  const unobserved=[],resizeObserver={unobserve:item=>unobserved.push(item)};
  const flags={visible:false,blocked:false,visibility:'visible',scrollOwner:''};
  const rows=0,retainPages=false,measurements=[],writes=[],probes=[];
  const fit={clientHeight:0,clientWidth:365};
  const style={width:'365px',gridTemplateColumns:'115px 115px 115px',rowGap:'10px',paddingTop:'2px',paddingBottom:'2px',getPropertyValue:()=>flags.scrollOwner};
  const item={classList:{contains:()=>false}};
  const itemStyle={height:'72px',boxSizing:'border-box',fontFamily:'fixture',fontSize:'14px',lineHeight:'16px'};
  const probe={style:{},removeAttribute(){},setAttribute(){},remove(){this.removed=true;},firstElementChild:item};
  const container={inert:true,clientWidth:365,classList:{contains:()=>false},getClientRects:()=>flags.visible?[{}]:[],cloneNode:()=>probe,removeAttribute(){}};
  const viewport={style:{},getClientRects:()=>flags.visible?[{}]:[],closest:()=>flags.blocked?{}:null,append:node=>assert.equal(node,probe)};
  const pager={classList:{remove(){}},getClientRects:()=>flags.visible?[{}]:[],dataset:new Proxy({}, {set(target,key,value){if(key==='pageSize')writes.push(value);target[key]=value;return true;}})};
  const getComputedStyle=node=>node===container?{...style,visibility:flags.visibility}:itemStyle;
  const renderItems=(items,message,target)=>{assert.equal(target,probe);probes.push(items.length);};
  const cancelNavigation=()=>{},closeEditor=()=>{},retirePaint=()=>{};
  let api;
  const model=new Pages(()=>api.publish());
  api=eval('(()=>{'+fitting+publishing+'return {controller:{'+updating+hiding+'},initialize:commitInitialCapacity,publish:publishPageSize,measure:measureCapacity,track:()=>{observedItem=item;}};})()');
  return {api,flags,model,fit,writes,probes,probe,measurements,style,itemStyle,container,unobserved,measure:()=>api.measure(probe.firstElementChild)};
}
const records=items(0,60),value={key:'owners',positionKey:'owners',items:records,total:60,hasMore:false};
const {api,flags,model,fit,writes,probes,probe,measurements}=fixture();
api.controller.update({...value,items:[],loading:true});
assert.deepEqual(writes,[],'loading has no guessed page size');
api.controller.update(value);
assert.deepEqual(writes,[],'a hidden panel cannot publish 6 or 12');
fit.clientHeight=404;api.initialize();
assert.deepEqual(writes,[],'a hidden panel still waits with measurable height');
flags.visible=true;api.initialize();
assert.deepEqual(writes,['15'],'the first commit comes directly from complete fitting rows');
assert.equal(model.items.length,15);assert.deepEqual(probes,[1]);
assert.equal(probe.style.visibility,'hidden');assert.equal(probe.removed,true);
assert.equal(measurements.at(-1).size,15);
api.controller.update({...value,items:[],loading:true});api.controller.update({...value,items:[...records]});
assert.equal(model.pageSize,15,'empty loading and refresh retain the fitted capacity');
assert.deepEqual(writes,['15'],'unchanged capacity produces no repeated attribute commits');
assert.deepEqual(probes,[1],'refresh does not restart bootstrap measurement');
for(const minimum of [1,()=>3])for(const height of [-1,0,1,75]) {
  const sample=fixture(minimum),expected=minimum===1?3:9;
  sample.flags.visible=true;sample.flags.blocked=true;sample.fit.clientHeight=height;
  sample.api.controller.update(value);
  assert.deepEqual(sample.writes,[],'hidden/inert/inactive panel ancestors still wait');
  sample.flags.blocked=false;sample.flags.visibility='hidden';sample.api.initialize();
  assert.deepEqual(sample.writes,[],'visibility:hidden must not initialize a page');
  sample.flags.visibility='visible';sample.api.initialize();
  assert.deepEqual(sample.writes,[String(expected)],'visible zero/short height commits the minimum rows from real columns');
  assert.equal(sample.model.items.length,expected,'visible short panels still render a full page');
  assert.equal(sample.measurements.at(-1).height,height,'diagnostics retain the actual height');
  sample.api.controller.update({...value,items:[],loading:true});sample.api.controller.update(value);
  assert.deepEqual(sample.writes,[String(expected)],'short-panel refresh does not republish capacity');
}
for(const minimum of [1,()=>3]) {
  const flow=fixture(minimum),expected=minimum===1?3:9;
  flow.flags.visible=true;flow.flags.scrollOwner='panel';flow.fit.clientHeight=404;
  flow.api.controller.update(value);
  assert.deepEqual(flow.writes,[String(expected)],'whole-panel scrolling starts with measured-column minimum rows');
  for(const height of [76,240,568,900]) {
    flow.fit.clientHeight=height;
    assert.equal(flow.measure(),expected,'growing natural content height cannot grow page capacity');
    assert.equal(flow.measurements.at(-1).height,height,'diagnostics still expose the real fit region');
    assert.equal(flow.measurements.at(-1).scrollOwner,'panel');
  }
  flow.flags.scrollOwner='';flow.fit.clientHeight=404;
  assert.equal(flow.measure(),15,'leaving the overlay restores bounded complete-row fitting');
}
let rowFloor=1;
const dynamic=fixture(()=>rowFloor);dynamic.flags.visible=true;dynamic.fit.clientHeight=404;
dynamic.api.controller.update(value);
for(const [itemHeight,height,expected] of [[73,404,12],[144,404,6],[144,150,3],[144,650,12],[72,322,12],[72,270,9],[72,322,12]]) {
  dynamic.itemStyle.height=String(itemHeight)+'px';dynamic.fit.clientHeight=height;
  assert.equal(dynamic.measure(),expected,'card height, 200% scaling, dock/IME and toolbar changes use current fit');
  assert.equal(dynamic.measurements.at(-1).itemHeight,itemHeight,'same font strings cannot retain an old card height');
  assert.equal(dynamic.measurements.at(-1).height,height);
}
dynamic.itemStyle.boxSizing='content-box';dynamic.itemStyle.height='60px';
Object.assign(dynamic.itemStyle,{paddingTop:'4px',paddingBottom:'4px',borderTopWidth:'1px',borderBottomWidth:'1px'});
dynamic.fit.clientHeight=404;
assert.equal(dynamic.measure(),15);assert.equal(dynamic.measurements.at(-1).itemHeight,70,'padding/borders belong to the measured layout height');
const count=dynamic.measurements.length;dynamic.measure();
assert.equal(dynamic.measurements.length,count,'unchanged geometry does not churn diagnostics');
dynamic.api.track();dynamic.api.controller.hide();
assert.deepEqual(dynamic.unobserved,[dynamic.probe.firstElementChild],'navigation releases the old first-card observer');
dynamic.flags.visible=false;dynamic.api.initialize();
assert.equal(dynamic.measurements.length,count,'hidden pages do not publish a new fit');
dynamic.style.gridTemplateColumns='175px 175px';dynamic.container.clientWidth=365;dynamic.fit.clientWidth=365;
dynamic.itemStyle.boxSizing='border-box';dynamic.itemStyle.height='212px';dynamic.fit.clientHeight=212;
dynamic.flags.scrollOwner='panel';dynamic.flags.visible=true;
assert.equal(dynamic.measure(),2,'landscape whole-panel rotation keeps one complete row');
rowFloor=3;dynamic.flags.scrollOwner='';dynamic.fit.clientHeight=510;dynamic.itemStyle.height='168px';
dynamic.api.controller.update(value);
assert.equal(dynamic.measure(),6,'portrait return restores minimum three rows using fresh geometry');
assert.equal(dynamic.measurements.at(-1).itemHeight,168);assert.equal(dynamic.measurements.at(-1).height,510);
assert.equal(dynamic.measurements.at(-1).minimumRows,3);assert.equal(dynamic.measurements.at(-1).scrollOwner,'viewport');
const {documentPageSize}=require('./static/result-pagination.js');
assert.deepEqual(documentPageSize,{song:6,compact:12});assert.ok(Object.isFrozen(documentPageSize));
`);
});

test('grid gap owner preserves desktop spacing without selecting native tablets [B2-G13-N1]', () => {
  const tokens=['--request-song-grid-gap','--request-compact-grid-gap'],policies=[],media=[];
  const gaps=rule=>rule.type==='style'?rule.value.declarations.declarations
    .filter(d=>d.property==='custom'&&tokens.includes(d.value.name)):[];
  for(const file of ['styles.css','remote.css','host-layout.css','ui-surfaces.css']) {
    const source=readFileSync(path.join(ROOT,'static',file),'utf8');
    cssTransform({filename:file,code:Buffer.from(source),visitor:{Rule(rule){
      for(const declaration of gaps(rule)) {
        const value=declaration.value.value;
        assert.equal(value.length,1);assert.equal(value[0].type,'length');assert.equal(value[0].value.unit,'px');
        policies.push({file,name:declaration.value.name,value:value[0].value.value,selectors:rule.value.selectors});
      }
      if(rule.type==='media'&&rule.value.rules.some(child=>gaps(child).length))media.push(rule.value);
    }}});
  }
  assert.deepEqual([...new Set(policies.map(policy=>policy.file))],['ui-surfaces.css'],
    'client sheets cannot create independent gap policies');
  const role=selector=>selector.filter(part=>part.type==='class'||part.type==='id')
    .map(part=>(part.type==='id'?'#':'.')+part.name).join(' ');
  assert.deepEqual(policies.map(policy=>[policy.name,policy.value,policy.selectors.map(role)]),[
    [tokens[0],8,['']], [tokens[1],10,['']], [tokens[0],10,['']],
    [tokens[0],16,['.category-browser-grid']], [tokens[0],12,['.category-browser-grid']],
    [tokens[1],12,['.tag-browser-tags']], [tokens[1],10,['#host-workspace-request .tag-browser-tags']]
  ],'base roles and the approved desktop exceptions retain their exact gaps');
  for(const policy of policies.slice(0,2))assert.deepEqual(policy.selectors,[[{type:'pseudo-class',kind:'root'}]]);
  const matches=(parts,attributes)=>parts.every(part=>{
    if(part.type==='pseudo-class'&&part.kind==='root')return true;
    if(part.type==='pseudo-class'&&part.kind==='not')return !part.selectors.some(selector=>matches(selector,attributes));
    assert.equal(part.type,'attribute');assert.equal(part.operation?.operator,'equal');
    return attributes[part.name]===part.operation.value;
  });
  const clients=[
    [{},true], [{'data-host-platform':'windows'},true], [{'data-host-platform':'macos'},true],
    [{'data-host-layout':'portrait'},false], [{'data-ui-client':'remote'},false],
    ...['android','ios'].flatMap(platform=>['portrait','landscape'].map(layout=>[
      {'data-host-platform':platform,'data-host-layout':layout,'data-host-columns':'two'},false
    ]))
  ];
  for(const policy of policies.slice(2))for(const selector of policy.selectors) {
    assert.deepEqual(selector[0],{type:'pseudo-class',kind:'root'});
    const end=selector.findIndex(part=>part.type==='combinator');
    const rootScope=end<0?selector:selector.slice(0,end);
    for(const [attributes,expected] of clients)assert.equal(matches(rootScope,attributes),expected,
      'desktop overrides must exclude portrait, Remote and native Android/iOS at every width: '+JSON.stringify(attributes));
  }
  assert.equal(media.length,1,'only the existing desktop category spacing uses a width response');
  assert.deepEqual(media[0].rules.flatMap(gaps).map(d=>[d.value.name,d.value.value[0].value.value]),[[tokens[0],12]]);
  const queries=media[0].query.mediaQueries;
  assert.equal(queries.length,1);assert.equal(queries[0].mediaType,'all');
  assert.equal(queries[0].condition.type,'feature');
  const feature=queries[0].condition.value;
  assert.equal(feature.type,'range');assert.equal(feature.name,'width');assert.equal(feature.operator,'less-than-equal');
  assert.deepEqual(feature.value.value.value,{unit:'px',value:760});
});
