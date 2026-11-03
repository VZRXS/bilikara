import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';
import {chromium} from 'playwright';

// Behavioral adapter tests on a current browser with isolated missing features.
// These never qualify a historic Android WebView; the actual provider is tested separately.
async function fixture(t, {legacy = false, missing = false, userAgent} = {}) {
  const server = createServer((req, res) => {
    if (req.url.endsWith('/native-fixture.css')) {
      const compiled = req.url.startsWith('/compat83/');
      const vars = compiled ? ':root{--sync-btn-bg:#fff;--ink:#000;--btn-secondary-bg:#fff;--accent:#f00}' : '';
      res.setHeader('Content-Type', 'text/css');
      const send = () => res.end(vars+'#native-gap{display:flex;gap:12px}#native-gap>span{display:block;width:10px;height:10px}#native-ratio{width:160px;aspect-ratio:16/9;--legacy-aspect-ratio:16/9}');
      if (compiled) setTimeout(send, 80); else send();
      return;
    }
    if (req.url === '/compat83/webview-legacy.css') return res.setHeader('Content-Type', 'text/css').end(readFileSync(new URL('../static/compat83/webview-legacy.css', import.meta.url)));
    if (req.url === '/webview83.js') return res.setHeader('Content-Type', 'text/javascript').end(readFileSync(new URL('../static/webview83.js', import.meta.url)));
    if (req.url === '/webview-compat.js') return res.setHeader('Content-Type', 'text/javascript').end(readFileSync(new URL('../static/webview-compat.js', import.meta.url)));
    if (req.url === '/webview-legacy.css') return res.setHeader('Content-Type', 'text/css').end(readFileSync(new URL('../static/webview-legacy.css', import.meta.url)));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><script src="/webview-compat.js"></script><link rel="stylesheet" href="/webview-legacy.css"><link rel="stylesheet" href="/native-fixture.css"><script src="/webview83.js"></script></head><body><div id="background" aria-hidden="false"><button id="first" tabindex="2">First</button></div><button id="outside">Outside</button><div id="native-gap"><span></span><span></span></div><div id="native-ratio"></div><form class="source-uid-form"><input><button class="source-refresh-button">Refresh</button></form><div class="request-workspace" style="width:520px"></div></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Browser cleanup runs later; retire its fixture connections before waiting.
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({headless: true}); t.after(() => browser.close());
  const context = await browser.newContext({userAgent});
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await context.addInitScript(({missing}) => {
    window.nativeHasOwn = Object.hasOwn;
    window.nativeAt = Array.prototype.at;
    window.nativeChildren = Element.prototype.replaceChildren;
    window.nativeReplace = String.prototype.replaceAll;
    window.nativeAnimate = Element.prototype.animate;
    window.nativeUUID = crypto.randomUUID;
    if (!missing) return;
    Object.defineProperty(Object, 'hasOwn', {configurable: true, writable: true, value: undefined});
    Object.defineProperty(Array.prototype, 'at', {configurable: true, writable: true, value: undefined});
    Object.defineProperty(crypto, 'randomUUID', {configurable: true, value: undefined});
    delete HTMLElement.prototype.inert;
    const supports = CSS.supports.bind(CSS);
    CSS.supports = function (rule, value) {
      if (['selector(:has(*))', 'height: 100dvh', 'container-type: size', 'color: color-mix(in srgb, black, white)'].includes(rule)) return false;
      return arguments.length === 1 ? supports(rule) : supports(rule, value);
    };
  }, {missing});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/${legacy ? '#bilikara-legacy' : ''}`);
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

test('latest leaves native implementations and input semantics untouched', async t => {
  const page = await fixture(t);
  assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.webviewMode,
    Object.hasOwn === nativeHasOwn, Array.prototype.at === nativeAt, crypto.randomUUID === nativeUUID,
    Element.prototype.replaceChildren === nativeChildren, String.prototype.replaceAll === nativeReplace, Element.prototype.animate === nativeAnimate,
    document.documentElement.hasAttribute('data-legacy-inert')]), ['latest', true, true, true, true, true, true, false]);
});

// UA strings select a profile only; these isolated missing-feature checks do
// not qualify a real Chromium 83 or 111 engine.
for (const major of [83, 111]) test(`standard mode never enables adapters implicitly (UA ${major}, missing APIs)`, async t => {
  const page = await fixture(t, {missing: true, userAgent: `Mozilla/5.0 Chrome/${major}.0.0.0`});
  assert.deepEqual(await page.evaluate(() => ({
    mode: document.documentElement.dataset.webviewMode,
    compatibility: typeof window.BilikaraWebViewCompatibility,
    missing: [typeof Object.hasOwn, typeof Array.prototype.at, typeof crypto.randomUUID,
      'inert' in HTMLElement.prototype],
    nativePaths: [Element.prototype.replaceChildren === nativeChildren,
      String.prototype.replaceAll === nativeReplace, Element.prototype.animate === nativeAnimate],
    legacyAttributes: document.querySelectorAll('[data-legacy-inert], [data-legacy-has], [data-legacy-engine], [data-legacy-colors], [data-legacy-containers]').length,
    redirectedStyles: Array.from(document.querySelectorAll('link[rel=stylesheet]')).some(link => new URL(link.href).pathname.startsWith('/compat83/')),
    compiledRequests: performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.startsWith('/compat83/')),
    viewportOverride: document.documentElement.style.getPropertyValue('--legacy-vh'),
  })), {
    mode: 'latest', compatibility: 'undefined', missing: ['undefined', 'undefined', 'undefined', false],
    nativePaths: [true, true, true], legacyAttributes: 0, redirectedStyles: false,
    compiledRequests: false, viewportOverride: '',
  });
});

test('legacy fills only missing primitives with correct generic indexing and secure UUIDs', async t => {
  const page = await fixture(t, {legacy: true, missing: true});
  assert.deepEqual(await page.evaluate(() => {
    const proto = {inherited: 1}, object = Object.assign(Object.create(proto), {own: 2});
    let rejectsNull = false, rejectsBigInt = false;
    try { Object.hasOwn(null, 'x'); } catch (e) { rejectsNull = e instanceof TypeError; }
    try { [1].at(1n); } catch (e) { rejectsBigInt = e instanceof TypeError; }
    return [Object.hasOwn(object, 'own'), Object.hasOwn(object, 'inherited'), rejectsNull,
      [1, 2, 3].at(-1), Array.prototype.at.call({0: 'a', 1: 'b', length: 2}, -1),
      [1].at(Infinity) === undefined, rejectsBigInt, Object.keys(Array.prototype).includes('at'),
      new Set(Array.from({length: 32}, () => crypto.randomUUID())).size];
  }), [true, false, true, 3, 'b', true, true, false, 32]);
  assert.match(await page.evaluate(() => crypto.randomUUID()), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('legacy inert blocks pointer, keyboard and programmatic focus; nested/dynamic controls restore', async t => {
  const page = await fixture(t, {legacy: true, missing: true});
  await page.evaluate(() => {
    window.activations = 0;
    document.querySelector('#first').onclick = () => activations++;
    document.querySelector('#background').inert = true;
    document.querySelector('#background').insertAdjacentHTML('beforeend', '<section id="nested" inert><button id="dynamic">Dynamic</button></section>');
  });
  await page.waitForFunction(() => document.querySelector('#dynamic').tabIndex === -1);
  assert.equal(await page.evaluate(() => {
    const first = document.querySelector('#first'); first.focus(); first.click();
    first.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
    return document.activeElement === first || activations !== 0;
  }), false);
  await page.locator('#outside').focus(); await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'first');
  await page.evaluate(() => { document.querySelector('#background').inert = false; });
  assert.equal(await page.locator('#first').getAttribute('tabindex'), '2');
  assert.equal(await page.locator('#background').getAttribute('aria-hidden'), 'false');
  assert.equal(await page.locator('#dynamic').getAttribute('tabindex'), '-1');
  await page.evaluate(() => { document.querySelector('#nested').inert = false; });
  assert.equal(await page.locator('#dynamic').getAttribute('tabindex'), null);
  await page.locator('#first').click(); assert.equal(await page.evaluate(() => activations), 1);
});

test('legacy relational styles, viewport and container sizes follow real DOM changes', async t => {
  const page = await fixture(t, {legacy: true, missing: true});
  await page.waitForFunction(() => document.querySelector('.source-uid-form').getAttribute('data-legacy-has')?.includes('r24'));
  await page.evaluate(() => document.querySelector('.source-refresh-button').remove());
  await page.waitForFunction(() => !document.querySelector('.source-uid-form').getAttribute('data-legacy-has').includes('r24'));
  await page.waitForFunction(() => document.querySelector('.request-workspace').hasAttribute('data-legacy-wide'));
  await page.evaluate(() => { document.querySelector('.request-workspace').style.width = '300px'; });
  await page.waitForFunction(() => !document.querySelector('.request-workspace').hasAttribute('data-legacy-wide'));
  await page.setViewportSize({width: 390, height: 650});
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--legacy-vh') === '6.5px');
});

// New shared relationships must be reviewed when extending the legacy surface.
test('every shared :has relationship retains a matching legacy adapter', () => {
  const source = readFileSync(new URL('../static/webview-compat.js', import.meta.url), 'utf8');
  const relations = JSON.parse(/var relations = (\[[\s\S]*?\n\]);/u.exec(source)[1]);
  const normalize = value => value.trim().replace(/\s+/gu, ' ');
  for (const name of readdirSync(new URL('../static/', import.meta.url)).filter(name => name.endsWith('.css'))) {
    const css = readFileSync(new URL('../static/' + name, import.meta.url), 'utf8');
    for (let start = css.indexOf(':has('); start >= 0; start = css.indexOf(':has(', start + 5)) {
      let depth = 1, end = start + 5;
      while (depth) { if (css[end] === '(') depth++; if (css[end] === ')') depth--; end++; }
      const relative = css.slice(start + 5, end - 1);
      const fallback = /^,\s*:where\(\[data-legacy-has~="([^"]+)"\]\)\)/u.exec(css.slice(end));
      assert.ok(fallback, name + ': missing legacy relationship');
      assert.ok(relations.some(([key, , query]) => key === fallback[1] && normalize(query) === normalize(relative)), name + ': adapter query drift');
    }
  }
});

// Modern-browser capability test only: the UA selects the legacy profile, but
// real historic 83 qualification remains in android_webview83.test.mjs/Android.
test('83–90 profile retains native flex gap, aspect ratio and animation APIs when present', async t => {
  const page=await fixture(t,{legacy:true,userAgent:'Mozilla/5.0 Chrome/89.0.4389.0'});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('link[rel=stylesheet]')).every(link=>link.href.includes('/compat83/')&&link.sheet));
  assert.deepEqual(await page.evaluate(()=>{
    const children=document.querySelector('#native-gap').children;
    return [BilikaraWebViewCompatibility.chromiumMajor,Element.prototype.animate===nativeAnimate,
      children[1].getBoundingClientRect().left-children[0].getBoundingClientRect().right,
      document.querySelector('#native-ratio').getBoundingClientRect().height,
      children[1].style.marginLeft,document.querySelector('#native-ratio').style.height];
  }),[89,true,12,90,'','']);
});

test('legacy colors refresh after replacement styles load instead of caching startup black', async t => {
  const page=await fixture(t,{legacy:true,missing:true,userAgent:'Mozilla/5.0 Chrome/89.0.4389.0'});
  await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--sync-btn-bg').trim()==='#fff');
  await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--legacy-pressed').trim()==='rgba(240,240,240,1)',null,{timeout:3000});
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--legacy-pressed').trim()),'rgba(240,240,240,1)');
});

test('legacy colors follow late CSS token changes without a theme toggle', async t => {
  const page=await fixture(t,{legacy:true,missing:true,userAgent:'Mozilla/5.0 Chrome/89.0.4389.0'});
  await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--legacy-pressed').trim()==='rgba(240,240,240,1)',null,{timeout:3000});
  await page.evaluate(()=>{
    document.documentElement.style.setProperty('--sync-btn-bg','#00ff00');
    document.querySelector('#background').classList.add('tokens-arrived');
  });
  await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--legacy-pressed').trim()==='rgba(0,240,0,1)',null,{timeout:3000});
});
