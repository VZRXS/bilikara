import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ResultPaginationFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")

    def run_case(self, source):
        result = subprocess.run(
            [self.node, "-"],
            input="""
const assert = require('node:assert/strict');
const { Pages, compactCount, swipeDirection, dotWindow, maximumPage } = require('./static/result-pagination.js');
const items = (offset, count) => Array.from({length: count}, (_, i) => ({id: offset + i}));
const initial = (extra = {}) => ({key: 'uploader', items: items(0, 100),
  total: 612, hasMore: true, ...extra});
(async () => {
""" + source + "\n})().catch(error => { console.error(error); process.exitCode = 1; });\n",
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_compact_totals_use_local_units_and_carry_rounding_at_boundaries(self):
        self.run_case("""
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
""")

    def test_direct_jump_fetches_beyond_initial_hundred_and_returns_to_cached_page(self):
        self.run_case("""
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
""")

    def test_small_cards_use_six_rows_and_preserve_the_visible_range_on_resize(self):
        self.run_case("""
const pages = new Pages();
const options = initial({items:items(0, 450), total:450, hasMore:false, pageSize:24});
pages.update(options);
assert.equal(pages.items.length, 24);
assert.equal(pages.pageCount, 19);
assert.equal(pages.peek(2)[0].id, 24);
await pages.goTo(3);
pages.update({...options,pageSize:12});
assert.equal(pages.page, 5);
assert.equal(pages.items[0].id, 48);
assert.equal(pages.items.length, 12);
assert.equal(pages.peek(4)[0].id, 36);
""")

    def test_three_row_grids_support_odd_column_counts_without_resetting_pages(self):
        self.run_case("""
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
""")

    def test_pending_and_failed_navigation_preserve_current_page_and_allow_retry(self):
        self.run_case("""
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
""")

    def test_replaced_source_ignores_both_late_success_and_failure(self):
        self.run_case("""
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
""")

    def test_partial_initial_batch_refetches_overlapping_page_without_skipping_items(self):
        self.run_case("""
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
""")

    def test_limited_results_remain_browsable_after_page_cache_eviction(self):
        self.run_case("""
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
""")

    def test_invalid_or_empty_response_does_not_advance_and_terminal_sets_known_total(self):
        self.run_case("""
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
""")

    def test_direction_lock_tolerates_diagonal_drift_but_preserves_vertical_scrolling(self):
        self.run_case("""
assert.equal(swipeDirection(-90, 8), 1);
assert.equal(swipeDirection(90, 8), -1);
assert.equal(swipeDirection(85, 70), -1);
assert.equal(swipeDirection(-90, 160, true), 1);
assert.equal(swipeDirection(90, -160, true), -1);
assert.equal(swipeDirection(40, 0, true), 0);
for (const [dx, dy] of [[-40, 0], [5, -160], [70, 85], [0, 0]]) {
  assert.equal(swipeDirection(dx, dy), 0);
}
""")

    def test_three_dot_window_highlights_then_shifts_in_both_directions(self):
        self.run_case("""
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
""")

    def test_shared_reads_only_current_page_and_two_ahead_without_eager_refills(self):
        self.run_case("""
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
""")

    def test_search_batches_cache_twelve_pages_without_background_reads(self):
        self.run_case("""
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
""")

    def test_shared_terminal_batch_preserves_short_last_page_and_stops_reading(self):
        self.run_case("""
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
""")

    def test_prefetch_warms_next_window_and_navigation_shares_pending_read(self):
        self.run_case("""
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
""")

    def test_last_page_warms_backward_search_window_without_per_page_reads(self):
        self.run_case("""
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
""")

    def test_jump_during_prefetch_still_warms_the_new_neighbors(self):
        self.run_case("""
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
""")

    def test_prefetch_failure_is_quiet_bounded_and_stale_results_are_discarded(self):
        self.run_case("""
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
""")

    def test_real_remote_adapter_preserves_source_filters_counts_and_legacy_limits(self):
        self.run_case(r"""
const fs = require('node:fs');
const script = fs.readFileSync('static/remote.js', 'utf8');
const begin = script.indexOf('function remoteResultPaginationOptions(');
const end = script.indexOf('\nfunction renderSearchResultItems(', begin);
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
""")
