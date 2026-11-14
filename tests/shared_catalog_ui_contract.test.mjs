import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {readUniqueJson} from './frontend_contract_support.mjs';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const translations = readUniqueJson(new URL('../static/i18n.json', import.meta.url)).languages;

test('i18n source rejects duplicate keys before JSON parsing can hide them', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'catalog-i18n-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'duplicate.json');
  const source = read('static/i18n.json');
  assert.doesNotThrow(() => readUniqueJson(new URL('../static/i18n.json', import.meta.url)));
  writeFileSync(file, source.replace(/("search.sharedPlaceholder": "[^"]*",)/,
    '$1\n      "search.sharedPlaceholder": "duplicate fixture",'), 'utf8');
  assert.throws(() => readUniqueJson(file), /Duplicate JSON key: search.sharedPlaceholder/);
});

test('Host and Remote retain their original three-language placeholder copy', () => {
  const original = {
    zh: ['在 bilikara 共享数据库中搜索', '在 bilikara 共享数据库中搜索'],
    en: ['Search the bilikara shared database', 'Search in bilikara shared database'],
    ja: ['bilikara 共有データベースを検索', 'bilikara共有データベースから検索'],
  };
  for (const [language, [host, remote]] of Object.entries(original)) {
    assert.equal(translations[language]['search.sharedPlaceholder'], host);
    assert.equal(translations[language]['search.sharedCatalogPlaceholder'], remote);
    assert.equal(translations[language]['search.larkPlaceholder'], undefined);
  }
  assert.match(read('static/index.html'), /data-i18n-placeholder="search.sharedPlaceholder"/);
  assert.match(read('static/remote.html'), /data-i18n-placeholder="search.sharedCatalogPlaceholder"/);
});

for (const [entry, script] of [['index.html', 'app.js'], ['remote.html', 'remote.js']]) {
  test(`${entry} shared search binds the same DOM, translations and canonical endpoint`, () => {
    const html = read('static/' + entry), js = read('static/' + script);
    for (const suffix of ['form', 'query', 'button', 'message', 'results']) {
      const id = 'shared-search-' + suffix;
      assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
      assert.ok(js.includes(`document.getElementById("${id}")`), id);
    }
    assert.match(js, /sharedSearchForm\?\.addEventListener\("submit",/);
    assert.match(js, /sharedSearchQuery\?\.addEventListener\("input",/);
    assert.match(js, /sharedSearchResults\?\.addEventListener\("click",/);
    assert.match(js, /\/api\/catalog\/search/);
    assert.match(js, /openSearchResultDetail\(event, elements\.sharedSearchResults, "shared"\)/);
    assert.doesNotMatch(html + js, /larkSearch|LarkSearch|lark-search|search\.lark|error\.lark|"lark"/);
    for (const language of ['zh', 'en', 'ja']) {
      for (const key of ['search.sharedPlaceholder', 'search.sharedCatalogPlaceholder', 'search.sharedSearching', 'search.sharedNoResults', 'search.sharedFound', 'error.sharedSearchFailed']) {
        assert.ok(translations[language][key]?.trim(), `${language}: ${key}`);
      }
    }
  });
}

test('shared search translations describe real loading, empty and error states', () => {
  assert.equal(translations.zh['search.sharedSearching'], '正在搜索 bilikara 共享数据库…');
  assert.equal(translations.ja['search.sharedSearching'], 'bilikara 共有データベースを検索しています…');
  for (const language of ['zh', 'en', 'ja']) {
    const values = translations[language];
    assert.doesNotMatch(values['search.sharedSearching'], /3\s*[-–〜]\s*15/);
    assert.equal(values['search.sharedFoundPartial'], undefined);
    assert.equal(values['search.sharedPartialNoResults'], undefined);
  }
  assert.doesNotMatch(read('static/app.js'), /partialFailure/);
});

function hostSearch() {
  const js = read('static/app.js');
  const source = js.slice(js.indexOf('async function handleSharedSearchSubmit('), js.indexOf('async function loadMoreHostSearchResults('));
  const mode = {draft: '', items: [], loading: false};
  const attributes = new Map(), messages = [], errors = [], appended = [], calls = [];
  const button = {disabled: false, setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k)};
  const results = {innerHTML: '', classList: {remove() {}}};
  const input = {value: '  karaoke  '};
  let resolve, reject, hidden = 0;
  const pending = new Promise((yes, no) => {resolve = yes; reject = no;});
  const state = {searchModeState: {shared: mode}, sharedSearchLoading: false, sharedSearchSeq: 0};
  const context = {
    state, elements: {sharedSearchQuery: input, sharedSearchButton: button, sharedSearchResults: results},
    t: key => key, androidBrowseEnabled: () => false,
    searchCatalog: query => {calls.push(query); return pending;},
    hideSharedSearchResults: () => {hidden++;},
    appendSearchResultItems: (container, items) => {assert.equal(container, results); appended.push(...items);},
    setSharedSearchMessage: message => messages.push(message),
    setAppMessage: (message, error) => errors.push({message, error}),
    syncHostSearchCounts() {},
  };
  vm.runInNewContext(source, context);
  return {mode, state, input, button, attributes, results, messages, errors, appended, calls, resolve, reject,
    hidden: () => hidden, submit: () => context.handleSharedSearchSubmit({preventDefault() {}})};
}

for (const source of ['cloudflare', 'sheets']) {
  test(`Host ${source} search preserves draft, busy guard, deduplication and page metadata`, async () => {
    const ui = hostSearch(), container = ui.results;
    const first = ui.submit();
    assert.equal(ui.button.disabled, true);
    assert.equal(ui.attributes.get('aria-busy'), 'true');
    assert.equal(ui.messages.at(-1), 'search.sharedSearching');
    await ui.submit();
    assert.deepEqual(ui.calls, ['karaoke']);
    const item = {bvid: 'BV1xx411c7mD', source};
    const page = {items: [item, item, {bvid: ''}], offset: 0, next_offset: 80, has_more: true, matched_count: 180};
    ui.resolve(page); await first;
    assert.deepEqual(ui.appended, [item]);
    assert.equal(ui.mode.items.length, 1);
    assert.equal(ui.mode.pageData, page);
    assert.equal(ui.mode.draft, '  karaoke  ');
    assert.equal(ui.input.value, '  karaoke  ');
    assert.equal(ui.results, container);
    assert.equal(ui.messages.at(-1), '');
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.attributes.has('aria-busy'), false);
  });
}

test('Host valid empty search and request failure have separate feedback and release busy state', async () => {
  const empty = hostSearch(), first = empty.submit();
  empty.resolve({items: [], matched_count: 0, has_more: false}); await first;
  assert.equal(empty.mode.message, 'search.sharedNoResults');
  assert.equal(empty.messages.at(-1), 'search.sharedNoResults');
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.hidden(), 1);
  assert.equal(empty.button.disabled, false);
  const failed = hostSearch(), second = failed.submit();
  failed.reject(new Error('catalog unavailable')); await second;
  assert.deepEqual(failed.errors, [{message: 'catalog unavailable', error: true}]);
  assert.equal(failed.messages.at(-1), '');
  assert.equal(failed.mode.error, 'catalog unavailable');
  assert.equal(failed.button.disabled, false);
  assert.equal(failed.attributes.has('aria-busy'), false);
});

test('Host outdated response cannot replace a newer search or release its pending guard', async () => {
  const ui = hostSearch(), first = ui.submit();
  ui.state.sharedSearchSeq++;
  const newer = [{bvid: 'BVNEW'}];
  ui.mode.items = newer;
  ui.resolve({items: [{bvid: 'BVOLD'}]}); await first;
  assert.equal(ui.mode.items, newer);
  assert.deepEqual(ui.appended, []);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.attributes.get('aria-busy'), 'true');
});
