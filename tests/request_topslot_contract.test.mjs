import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const read=name=>readFileSync(new URL(`../static/${name}`,import.meta.url),'utf8');
test('search allocates remaining space to the actual result owner without optional grid tracks',()=>{
  const css=read('styles.css');
  const panel=css.match(/\.request-search-view > \.request-mode-panel \{([^}]+)\}/)[1];
  assert.match(panel,/display: flex/);
  assert.match(panel,/flex-direction: column/);
  assert.doesNotMatch(panel,/grid-template-rows/);
  assert.match(css,/\.request-mode-panel > :is\(\.search-results, \.android-result-frame\) \{\s*flex: 1 1 0;\s*min-height: 0;/);
});
test('native contextual tag ordering covers landscape and tablet layouts',()=>{
  const css=read('host-layout.css');
  assert.doesNotMatch(css,/html\[data-host-layout="portrait"\] \.request-discover-view \.tag-browser\.is-browsing-tags/);
  for(const [child,row] of [['.browse-search-bar',1],['.android-result-frame:not([hidden])',2]]) {
    assert.ok(css.includes(`html:is([data-host-platform="android"], [data-host-platform="ios"]) .request-discover-view .tag-browser.is-browsing-tags > ${child} { grid-row: ${row}; }`));
  }
});
test('Host and Remote share TopSlot spacing without overriding source footer or cover-strip roles',()=>{
  const shared=read('request-tabs.css');
  assert.match(shared,/--request-top-content-gap: 12px;/);
  assert.match(shared,/--request-content-paint-inset: 2px;/);
  assert.match(shared,/row-gap: calc\(var\(--request-top-content-gap\) - var\(--request-content-paint-inset\)\);/);
  assert.match(shared,/padding-top: var\(--request-content-paint-inset\);/);
  const gapRule=shared.match(/([^{}]+)\{\s*row-gap: calc\(var\(--request-top-content-gap\) - var\(--request-content-paint-inset\)\);\s*\}/)[1];
  assert.doesNotMatch(gapRule,/source-mode-panel/,'the source footer keeps its independently specified gap');
  assert.match(shared,/\.source-mode-panel > \.source-action-row \{\s*margin-bottom: calc\(var\(--request-top-content-gap\) - var\(--request-content-paint-inset\) - 8px\);/);
  assert.match(read('source-removal.css'),/\.source-mode-panel \{[^}]*row-gap: 8px;/);
  assert.doesNotMatch(shared,/--category-browser-tab-height\s*:/);
  assert.doesNotMatch(shared,/scrollbar-width\s*:/);
  assert.match(read('styles.css'),/--category-browser-tab-height: 74px/);
  assert.match(read('styles.css'),/--category-browser-tab-height: 64px/);
  assert.match(read('remote.css'),/--category-browser-tab-height: 64px/);
  assert.match(read('remote.css'),/\.search-results \{[^}]*margin-top: 0;/);
  for(const name of ['styles.css','host-layout.css','remote.css']) {
    assert.doesNotMatch(read(name),/--request-top-content-gap\s*:/,name);
  }
  assert.match(read('styles.css'),/margin-top: calc\(-1 \* var\(--request-content-paint-inset\)\);\s*padding-top: var\(--request-content-paint-inset\);/);
  assert.match(read('styles.css'),/\.source-browse-scroll\.is-detail-view \.follow-up-items-view \{\s*height: 100%;\s*padding-top: 0;/);
});
