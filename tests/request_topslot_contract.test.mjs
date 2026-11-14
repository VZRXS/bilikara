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
