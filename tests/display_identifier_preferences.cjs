'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'static/display-identifier.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'static/display-identifier.html'), 'utf8');
assert(!/<script>([\s\S]*?)<\/script>/.test(html), 'Native CSP rejects inline theme initialization');
assert(html.indexOf('/display-identifier.js') < html.indexOf('/display-identifier.css'), 'Theme must initialize before styles');
(async () => {
  let resolveCatalog;
  const listeners = new Map(), domListeners = new Map();
  const nodes = new Map(), element = {dataset: {}, lang: ''};
  const document = {documentElement: element, getElementById: id => nodes.get(id), addEventListener: (name, fn) => domListeners.set(name, fn)};
  const window = {location: {search: '?number=2&theme=dark&language=ja&role=audience'}, addEventListener: (name, fn) => listeners.set(name, fn)};
  const channels = [];
  window.BroadcastChannel = class {
    constructor(name) { this.name = name; channels.push(this); }
    addEventListener(name, fn) { assert.equal(name, 'message'); this.receive = fn; }
    close() { this.closed = true; }
  };
  vm.runInNewContext(script, {window, document, URLSearchParams, fetch: () => new Promise(resolve => {resolveCatalog = resolve})});
  assert.equal(element.dataset.theme, 'dark');
  assert.equal(element.lang, 'ja');
  nodes.set('display-identifier-number', {});nodes.set('display-identifier-role', {});
  domListeners.get('DOMContentLoaded')();
  assert.equal(nodes.get('display-identifier-number').textContent, '2');
  listeners.get('storage')({key: 'bilikara.ui.theme', newValue: 'blue'});
  listeners.get('storage')({key: 'bilikara.ui.language', newValue: 'en'});
  assert.equal(element.dataset.theme, 'blue');assert.equal(element.lang, 'en');
  assert.equal(nodes.get('display-identifier-role').textContent, 'Audience display');
  // A late catalog must use the current language, not the opening language.
  resolveCatalog({ok: true, json: async () => ({languages: {en: {'display.identifierAudience': 'Translated audience'}, ja: {'display.identifierAudience': '古い言語'}}})});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('display-identifier-role').textContent, 'Translated audience');
  assert.equal(channels[0].name, 'bilikara-host-appearance');
  channels[0].receive({data: {theme: 'blue', language: 'ja'}});
  assert.equal(element.dataset.theme, 'blue');assert.equal(element.lang, 'ja');
  assert.equal(nodes.get('display-identifier-role').textContent, '古い言語');
  listeners.get('storage')({key: 'bilikara.ui.theme', newValue: 'invalid'});
  assert.equal(element.dataset.theme, 'light');
  assert.equal(nodes.get('display-identifier-number').textContent, '2');
  assert.equal(element.dataset.displayRole, 'audience');
  listeners.get('pagehide')();assert.equal(channels[0].closed, true);
  console.log('PASS: CSP-compatible display theme and live language preferences');
})().catch(error => {console.error(error);process.exitCode = 1});
