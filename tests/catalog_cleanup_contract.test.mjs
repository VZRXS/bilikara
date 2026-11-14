import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const smoke = read('scripts/dev_smoke_test.py');
// The smoke expectation dictionary is a literal shared by Python and JS syntax.
// Exercise its catalog subset without starting the full interactive source Host.
const literal = smoke.match(/expected_tokens = (\{[\s\S]*?\n        \})/);
assert.ok(literal, 'the smoke gate retains its expected surface checks');
const expected = vm.runInNewContext('(' + literal[1] + ')');

for (const [route, file, count] of [['/', 'index.html', 6], ['/remote', 'remote.html', 6], ['/app.js', 'app.js', 4], ['/remote.js', 'remote.js', 4]]) {
  test(`developer smoke checks the current shared catalog surface in ${route}`, () => {
    const tokens = Array.from(expected[route]).filter(token => /shared-search|search-shared|sharedSearch|\/api\/catalog\/search/.test(token));
    assert.equal(tokens.length, count);
    const body = read('static/' + file);
    const missing = value => tokens.filter(token => !value.includes(token));
    assert.deepEqual(missing(body), []);
    for (const token of tokens) {
      assert.ok(missing(body.replace(token, 'disconnected-catalog-fixture')).includes(token), token);
    }
  });
}

test('catalog smoke migration retains the surrounding smoke gates', () => {
  assert.doesNotMatch(smoke, /search-lark-toggle|lark-search-form/);
  for (const token of ['follow-up-grid', 'binding-modal-confirm', 'gatcha-favlist-modal', 'binding-sheet-actions', 'history-export-row']) {
    assert.ok(smoke.includes(token), token);
  }
  assert.match(smoke, /self\.check_recent_feature_static_surface\(static_bodies\)/);
  assert.match(smoke, /raise RuntimeError\(f"\{path\} missing recent UI token/);
});
