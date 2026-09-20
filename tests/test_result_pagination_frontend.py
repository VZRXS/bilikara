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
            cwd=ROOT, capture_output=True, text=True, timeout=10,
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
  return {items: items(range.offset, 4), offset: range.offset,
    matched_count: 612, has_more: true, next_offset: range.offset + 4};
}});
pages.update(input);
assert.equal(pages.pageCount, 153);
await pages.goTo(126);
assert.deepEqual(calls, [{offset: 500, limit: 4}]);
assert.equal(pages.items[0].id, 500);
pages.update(input); // An unrelated SSE render preserves the visible page.
assert.equal(pages.page, 126);
await pages.goTo(2);
assert.equal(pages.items[0].id, 4);
await pages.goTo(126);
assert.equal(calls.length, 1);
""")

    def test_pending_and_failed_navigation_preserve_current_page_and_allow_retry(self):
        self.run_case("""
let reject, calls = 0;
const pages = new Pages();
pages.update(initial({load: () => { calls++; return new Promise((_, fail) => {reject = fail}); }}));
const pending = pages.goTo(26);
assert.equal(pages.loading, true);
assert.equal(pages.page, 1);
assert.equal(await pages.goTo(27), false);
assert.equal(calls, 1);
reject(new Error('offline'));
await assert.rejects(pending, /offline/);
assert.equal(pages.loading, false);
assert.equal(pages.page, 1);
assert.equal(pages.items[0].id, 0);
pages.load = async () => ({items: items(100, 4), matched_count: 612, has_more: true, next_offset: 104});
assert.equal(await pages.goTo(26), true);
""")

    def test_replaced_source_ignores_both_late_success_and_failure(self):
        self.run_case("""
for (const fail of [false, true]) {
  let resolve, reject;
  const pages = new Pages();
  pages.update(initial({load: () => new Promise((yes, no) => { resolve = yes; reject = no; })}));
  const pending = pages.goTo(26);
  pages.update(initial({key: 'other', items: items(800, 20), total: 20, hasMore: false}));
  if (fail) reject(new Error('old request failed'));
  else resolve({items: items(100, 4), has_more: false});
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
pages.update(initial({items: items(0, 450), total: null, load: async range => {
  requested = range;
  return {items: items(range.offset, 4), offset: range.offset,
    next_offset: range.offset + 4, has_more: true};
}}));
await pages.goTo(113);
assert.deepEqual(requested, {offset: 448, limit: 4});
assert.deepEqual(pages.items.map(item => item.id), items(448, 4).map(item => item.id));
assert.equal(pages.pageCount, null);
""")

    def test_limited_results_remain_browsable_after_page_cache_eviction(self):
        self.run_case("""
const pages = new Pages();
pages.update(initial({items: items(0, 450), total: 450, hasMore: false, limited: true}));
for (let page = 1; page <= 113; page++) await pages.goTo(page);
assert.equal(pages.items.length, 2);
assert.equal(pages.canNext, false);
assert.ok(pages.cache.size <= 12);
await pages.goTo(2);
assert.equal(pages.items[0].id, 4);
await assert.rejects(pages.goTo(114), RangeError);
for (const page of [0, -1, 2.5, NaN, Infinity]) await assert.rejects(pages.goTo(page), RangeError);
""")

    def test_invalid_or_empty_response_does_not_advance_and_terminal_sets_known_total(self):
        self.run_case("""
const pages = new Pages();
pages.update(initial({total: null}));
for (const response of [
  {items: []}, {items: 'invalid'},
  {items: items(100, 4), offset: 0},
  {items: items(100, 4), has_more: true, next_offset: 100},
]) {
  pages.load = async () => response;
  await assert.rejects(pages.goTo(26));
  assert.equal(pages.page, 1);
  assert.equal(pages.items[0].id, 0);
  assert.equal(pages.loading, false);
}
pages.load = async () => ({items: items(100, 3), offset: 100, has_more: false});
await pages.goTo(26);
assert.equal(pages.total, 103);
assert.equal(pages.pageCount, 26);
assert.equal(pages.canNext, false);
await pages.goTo(1);
assert.equal(pages.canNext, true);
""")

    def test_vertical_and_diagonal_gestures_do_not_turn_pages(self):
        self.run_case("""
assert.equal(swipeDirection(-90, 8), 1);
assert.equal(swipeDirection(90, 8), -1);
for (const [dx, dy] of [[-40, 0], [5, -160], [85, 70], [0, 0]]) {
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
pages.update(initial({items: items(0,12), total: null, readAhead: 2, load: async range => {
  calls.push(range);
  return {items: items(range.offset,12), offset: range.offset,
    has_more:true,next_offset:range.offset+12};
}}));
await pages.goTo(2);
await pages.goTo(3);
assert.equal(calls.length, 0);
await pages.goTo(4);
assert.deepEqual(calls, [{offset:12, limit:12}]);
assert.equal(pages.items.length,4);
await pages.goTo(5);
await pages.goTo(6);
assert.equal(calls.length,1);
await pages.goTo(126);
assert.deepEqual(calls[1], {offset:500,limit:12});
await pages.goTo(128);
assert.equal(calls.length,2);
assert.equal(pages.items[0].id,508);
await assert.rejects(pages.goTo(maximumPage+1), RangeError);
""")

    def test_shared_terminal_batch_preserves_short_last_page_and_stops_reading(self):
        self.run_case("""
let calls = 0;
const pages = new Pages();
pages.update(initial({items: items(0,12), total: null, readAhead: 2, load: async range => {
  calls++;
  assert.deepEqual(range, {offset:12,limit:12});
  return {items:items(12,6),offset:12,has_more:false,next_offset:18};
}}));
await pages.goTo(4);
assert.equal(pages.total,18);
assert.equal(pages.pageCount,5);
await pages.goTo(5);
assert.equal(pages.items.length,2);
assert.equal(pages.canNext,false);
await pages.goTo(2);
await pages.goTo(5);
assert.equal(calls,1);
""")

    def test_real_remote_adapter_preserves_source_filters_and_distinguishes_capped_search(self):
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
const canonicalBilikaraSearch = {seq: 9, loading: false};
const fetchGatchaBrowse = (...args) => args;
const fetchGatchaFavlistBrowse = (...args) => args;
const fetchD1Browse = args => args;
const mode = {letter: 'A', tag: 'Artist', locale: 'ja', query: 'song', seq: 2,
  data: {has_more: true}, loading: false};
const d1BrowseModeState = () => mode;
eval(script.slice(begin, end));
const range = {offset: 500, limit: 4};
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
assert.equal(shared.total, 80);
assert.equal(shared.limited, true);
assert.equal(shared.load, null);
""")
