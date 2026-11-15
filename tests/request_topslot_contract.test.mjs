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

test('source detail wrappers pass header hover paint to the outer inset while only results scroll',()=>{
  const css=read('styles.css');
  for(const selector of [
    '.request-sources-view .source-browse-scroll.is-detail-view > :is(.follow-browser, .favlist-browser)',
    '.request-sources-view .source-browse-scroll.is-detail-view .follow-up-items-view',
  ]) {
    const rule=css.slice(css.indexOf(selector+' {')).split('}',1)[0];
    assert.match(rule,/overflow: visible;/,selector);
    assert.match(rule,/height: 100%;/,selector);
    assert.match(rule,/grid-template-rows:/,selector);
  }
  assert.match(css,/\.source-browse-scroll\.is-detail-view \{\s*overflow-y: hidden;/);
  assert.match(css,/\.source-browse-scroll\.is-detail-view :is\(#follow-song-results, #favlist-song-results\) \{[^}]*overflow-y: auto;/);
});

test('English Remote UID rows reserve input space and fit two text lines in the ordinary control height',()=>{
  const css=read('request-tabs.css');
  const rule=selector=>{
    const start=css.indexOf(selector+' {');
    assert.ok(start>=0,selector);
    return css.slice(start).split('}',1)[0];
  };
  const form=rule(':root .source-uid-form'),input=rule(':root .source-uid-form > input');
  assert.match(form,/grid-template-columns: minmax\(var\(--source-uid-input-min-width, 0px\), 1fr\) var\(--source-uid-action-track, auto\);/);
  assert.match(input,/min-width: var\(--source-uid-input-min-width, 0px\);/);
  assert.match(rule(':root[data-ui-client="remote"]:lang(en) .source-uid-form'),/--source-uid-input-min-width: 128px;/);
  assert.match(rule(':root[data-ui-client="remote"]:lang(en) .source-uid-form'),/--source-uid-action-track: minmax\(min-content, auto\);/,'action tracks reserve the longest word even during loading');
  const button=rule(':root .source-uid-form > button');
  assert.match(button,/min-width: 44px;/,'short labels keep their ordinary minimum target');
  assert.match(button,/white-space: nowrap;/,'ordinary languages keep the original single-line rule');
  assert.match(css,/@media \(max-width: 520px\) \{\s*:root\[data-ui-client="remote"\]:lang\(en\) \.source-uid-form > button/);
  const narrow=rule(':root[data-ui-client="remote"]:lang(en) .source-uid-form > button');
  assert.match(narrow,/white-space: normal;/);
  assert.match(narrow,/font-size: var\(--remote-peer-action-font-size, 16px\);/);
  assert.doesNotMatch(narrow,/^\s*(?:min-|max-)?(?:width|height):/m,'wrapping must not assign label widths or enlarge controls');
  const height=Number(button.match(/\bheight: (\d+)px;/)[1]);
  const lineHeight=Number(narrow.match(/line-height: (\d+)px;/)[1]);
  const padding=Number(narrow.match(/padding: (\d+)px/)[1]);
  assert.equal(height,44);
  // CSS budget only: WSL rendering separately verifies wrapping and glyph bounds.
  assert.ok(2*lineHeight+2*padding+2<=height,'two lines leave room for padding and a possible 1px border');
});
