import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const load = file => readFileSync(new URL('../static/' + file, import.meta.url), 'utf8');

test('portrait My/Settings own full-width scrolling and internal content gutters [B3-G2]', () => {
  const css = load('host-layout.css');
  assert.match(css, /html\[data-host-layout="portrait"\]\[data-host-page="my"\] \.shell-body\s*\{\s*padding-inline: 0;\s*\}/);
  for (const owner of ['android-my-scroll', 'settings-workspace-body']) {
    assert.match(css, new RegExp('html\\[data-host-layout="portrait"\\] \\.' + owner
      + '\\s*\\{\\s*padding: 0 14px calc\\(var\\(--mobile-content-trailing-inset\\) \\+ 14px\\);\\s*\\}'));
  }
  // G2 moves only the side gutters; the existing dock/trailing relationship
  // remains part of the contract until D1 is decided.
  assert.match(css, /:is\(\.android-my-scroll, \.settings-workspace-body\)\s*\{\s*scroll-padding-bottom: calc\(var\(--mobile-content-trailing-inset\) \+ 14px\);/);
});
