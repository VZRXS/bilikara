import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { webkit } from 'playwright';
import { root } from './desktop_construction_support.mjs';

test('actual shared SVG copies retain geometry with independent document masks', async () => {
  const html = readFileSync(path.join(root, 'static/index.html'), 'utf8');
  const source = readFileSync(path.join(root, 'static/host-layout.js'), 'utf8');
  const clone = source.slice(source.indexOf('  const workspaceButtons ='), source.indexOf('  const pages = new Set('));
  assert.ok(clone.includes('cloneNode(true)'));
  const browser = await webkit.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Parse the current markup without running unrelated application scripts.
    await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    await page.addScriptTag({ content: clone });
    const result = await page.evaluate(() => {
      const definitions = [...document.querySelectorAll('[id]')];
      const original = document.querySelector('#work-rail-users .work-rail-icon');
      const copy = document.querySelector('[data-android-page="users"] svg');
      const normalize = svg => {
        const clone = svg.cloneNode(true); clone.removeAttribute('class');
        const mask = clone.querySelector('mask');
        for (const reference of clone.querySelectorAll('[mask]')) {
          if (reference.getAttribute('mask') === `url(#${mask.id})`) reference.setAttribute('mask', 'url(#same-mask)');
        }
        mask.id = 'same-mask'; return clone.innerHTML;
      };
      return {
        ids: definitions.map(node => node.id), originalMask: original.querySelector('mask').id,
        copyMask: copy.querySelector('mask').id, reference: copy.querySelector('[mask]').getAttribute('mask'),
        geometry: [normalize(original), normalize(copy)],
        originalCount: document.querySelectorAll('#work-rail-users-separation').length,
        targetIsInsideCopy: document.getElementById(copy.querySelector('mask').id)?.closest('svg') === copy,
      };
    });
    assert.equal(new Set(result.ids).size, result.ids.length, 'every document ID is unique');
    assert.equal(result.originalCount, 1);
    assert.equal(result.originalMask, 'work-rail-users-separation');
    assert.notEqual(result.copyMask, result.originalMask);
    assert.equal(result.reference, `url(#${result.copyMask})`);
    assert.equal(result.targetIsInsideCopy, true);
    assert.equal(result.geometry[0], result.geometry[1], 'all shared geometry and mask operations stay identical');
  } finally { await browser.close(); }
});
