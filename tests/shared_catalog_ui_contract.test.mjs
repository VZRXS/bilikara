import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const translations = JSON.parse(read('static/i18n.json')).languages;

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
      for (const key of ['search.sharedPlaceholder', 'search.sharedSearching', 'search.sharedNoResults', 'search.sharedFound', 'error.sharedSearchFailed']) {
        assert.ok(translations[language][key]?.trim(), `${language}: ${key}`);
      }
    }
  });
}
