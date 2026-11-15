// Request grid contract for B2 step 4 (R8 §25: G8 tablet song columns, G10 single page-capacity authority,
// G12 equal card heights within a grid, G13 shared SongGrid/CompactGrid gaps). Baseline and gap list:
// bilikara-next-10 artifact b2-measure.md §7. Real Rust Hosts (desktop host and Android alpha) with the shipped
// static UI; catalog/source HTTP is answered by deterministic browser routes.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {after, before} from 'node:test';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha, buildNativeHost} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

const linux = process.platform === 'linux';
let alphaBinary, desktopBinary, remoteDevices = 0;
const hosts = new Map(), homes = [];
before(async () => {
  if (!linux) return;
  alphaBinary = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();
  desktopBinary = process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
}, {timeout: 600000});
after(async () => {
  for (const host of hosts.values()) await host.close();
  for (const home of homes) rmSync(home, {recursive: true, force: true});
});

// ---------- fixtures ----------
const titles = ['Short', '残酷な天使のテーゼ (TV size) カラオケ', 'A very long English karaoke title that keeps going for two lines and more',
  '只有一行', 'KOTOKO - 覚えてていいよ / off vocal 有和声 歌词字幕版 超长标题测试', '恋爱循环'];
const songs = Array.from({length: 600}, (_, i) => ({bvid: 'BV' + String(i + 1).padStart(10, '0'), title: `${titles[i % titles.length]} #${i + 1}`,
  // Every fourth song has no owner, so grids mix owner badges with missing-owner metadata rows (G12).
  owner_name: i % 4 === 3 ? '' : i % 3 ? 'Fixture UP' : '很长的 UP 主名字 Fixture', mid: i % 4 === 3 ? '' : '42', duration: 200 + i, play: 1000 * i,
  cover_url: `/grid-covers/${i % 2}.svg`, pic: `/grid-covers/${i % 2}.svg`, url: `https://www.bilibili.com/video/BV${String(i + 1).padStart(10, '0')}`}));
const owners = Array.from({length: 61}, (_, i) => ({uid: String(42 + i), name: `测试 UP ${i + 1}`, count: 600 - i, avatar_url: '/pic/icon.png'}));
const folders = owners.map(owner => ({...owner, id: `${owner.uid}:7`, folder_id: '7', media_id: '7', title: `收藏夹 ${owner.uid}`}));
const tags = Array.from({length: 70}, (_, i) => ({tag: `Artist ${i}`, letter: 'A', count: 10 + i, locale: ''}));
const covers = ['#587ba0', '#a05858'].map(fill => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${fill}"/></svg>`);
function paged(rows, url, limit = 80) {
  const offset = Number(url.searchParams.get('offset') || 0), size = Number(url.searchParams.get('limit') || limit);
  return {items: rows.slice(offset, offset + size), offset, limit: size, matched_count: rows.length,
    has_more: offset + size < rows.length, next_offset: Math.min(offset + size, rows.length)};
}
function fixtureApi(url) {
  const name = url.pathname, query = url.searchParams.get('q') || '';
  if (name === '/api/catalog/search' || name === '/api/gatcha/search') return {...paged(songs, url), query, result_kind: 'songs'};
  if (name === '/api/d1/category-browse') return {...paged(songs, url, 100), tags: [], query};
  if (name === '/api/d1/browse') {
    const tag = url.searchParams.get('tag');
    return tag ? {kind: url.searchParams.get('kind'), letter: url.searchParams.get('letter'), tag, tags: [], ...paged(songs, url, 100)}
      : {kind: url.searchParams.get('kind'), letter: url.searchParams.get('letter'), query, tags, items: []};
  }
  if (name === '/api/gatcha/browse') {
    const uid = url.searchParams.get('uid') || '';
    return {owners, selected_uid: uid, query, source_order_version: 'a'.repeat(64), source_order_editable: true, source_order_count: owners.length,
      ...(uid ? paged(songs, url, 100) : {items: [], matched_count: 0, has_more: false})};
  }
  if (name === '/api/gatcha/favlist/browse') {
    const folder = url.searchParams.get('folder_id') || '';
    return {folders, owners, selected_folder_id: folder, query, source_order_version: 'b'.repeat(64), source_order_editable: true,
      source_order_count: folders.length, ...(folder ? paged(songs, url, 100) : {items: [], matched_count: 0, has_more: false})};
  }
  if (name === '/api/gatcha/pool-config') return {uid_weight: 50, excluded_uids: [], excluded_favlist_folders: [], uid_options: owners.slice(0, 3), favlist_folder_options: []};
  return null;
}

// ---------- pages ----------
const pages = {
  'search-results': {grid: '#shared-search-results', card: '.search-result-item',
    host: [['request', 'search'], ['click', '[data-search-mode="shared"]'], ['fill', '#shared-search-query', 'fixture'], ['click', '#shared-search-button'], ['wait', '#shared-search-results .search-result-item']],
    remote: [['click', '[data-remote-request-view="search"]'], ['click', '[data-remote-search-mode="shared"]'], ['fill', '#shared-search-query', 'fixture'], ['click', '#shared-search-button'], ['wait', '#shared-search-results .search-result-item']]},
  'name-results': {grid: null, card: '.search-result-item',
    host: [['request', 'discover'], ['click', '[data-discover-mode="name"]'], ['click', '#request-discover-name .tag-letter-button[data-letter="A"]'], ['wait', '#request-discover-name .tag-browser-tag'],
      ['click', '#request-discover-name .tag-browser-tag'], ['wait', '#request-discover-name .search-result-item']],
    remote: [['click', '[data-remote-request-view="discover"]'], ['click', '[data-remote-discover-mode="name"]'], ['click', '#remote-discover-name-panel .tag-letter-button[data-letter="A"]'],
      ['wait', '#remote-discover-name-panel .tag-browser-tag'], ['click', '#remote-discover-name-panel .tag-browser-tag'], ['wait', '#remote-discover-name-panel .search-result-item']]},
  'source-list': {grid: null, card: '.follow-up-button,.source-removal-card', compact: true,
    host: [['request', 'sources'], ['click', '[data-sources-mode="uids"]'], ['wait', '#follow-up-grid [data-uid]']],
    remote: [['click', '[data-remote-request-view="sources"]'], ['click', '[data-remote-sources-mode="uids"]'], ['wait', '#sources-follow-grid [data-uid]']]},
  'uid-detail': {grid: null, card: '.search-result-item',
    host: [['request', 'sources'], ['click', '[data-sources-mode="uids"]'], ['wait', '#follow-up-grid [data-uid]'], ['click', '#follow-up-grid [data-uid]'], ['wait', '#follow-song-results .search-result-item']],
    remote: [['click', '[data-remote-request-view="sources"]'], ['click', '[data-remote-sources-mode="uids"]'], ['wait', '#sources-follow-grid [data-uid]'], ['click', '#sources-follow-grid [data-uid]'], ['wait', '#sources-follow-results .search-result-item']]},
  'favorites-detail': {grid: null, card: '.search-result-item',
    host: [['request', 'sources'], ['click', '[data-sources-mode="favorites"]'], ['wait', '#favlist-grid [data-folder-id]'], ['click', '#favlist-grid [data-folder-id]'], ['wait', '#favlist-song-results .search-result-item']],
    remote: [['click', '[data-remote-request-view="sources"]'], ['click', '[data-remote-sources-mode="favorites"]'], ['wait', '#favlist-grid [data-folder-id]'], ['click', '#favlist-grid [data-folder-id]'], ['wait', '#remote-sources-favorites-panel .search-result-item']]},
  'name-tags': {grid: null, card: '.tag-browser-tag',
    host: [['request', 'discover'], ['click', '[data-discover-mode="name"]'], ['click', '#request-discover-name .tag-letter-button[data-letter="A"]'], ['wait', '#request-discover-name .tag-browser-tag']]},
  'artist-tags': {grid: null, card: '.tag-browser-tag',
    host: [['request', 'discover'], ['click', '[data-discover-mode="artist"]'], ['click', '#request-discover-artist .tag-letter-button[data-letter="A"]'], ['wait', '#request-discover-artist .tag-browser-tag']]},
  'artist-results': {grid: null, card: '.search-result-item',
    host: [['request', 'discover'], ['click', '[data-discover-mode="artist"]'], ['click', '#request-discover-artist .tag-letter-button[data-letter="A"]'], ['wait', '#request-discover-artist .tag-browser-tag'],
      ['click', '#request-discover-artist .tag-browser-tag'], ['wait', '#request-discover-artist .search-result-item']]},
  'favorites-list': {grid: null, card: '.follow-up-button,.source-removal-card',
    host: [['request', 'sources'], ['click', '[data-sources-mode="favorites"]'], ['wait', '#favlist-grid [data-folder-id]']]},
};

async function host(kind) {
  if (hosts.has(kind)) return hosts.get(kind);
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara-grid-contract-')); homes.push(home);
  const statics = path.join(root, 'static');
  const running = kind === 'alpha'
    ? await RunningHost.start(alphaBinary, home, [home, statics], isolatedEnvironment(home), true)
    : await RunningHost.start(desktopBinary, home, ['--headless', '--port', '0', '--data-dir', path.join(home, 'data'), '--static-dir', statics], isolatedEnvironment(home));
  await running.api('/api/session-users/add', {name: 'Grid singer'});
  hosts.set(kind, running);
  return running;
}

async function settle(page) {
  // Wait only for finite animations on rendered nodes; WebKit can keep unresolved transitions on hidden nodes.
  await page.evaluate(async () => {
    await document.fonts.ready;
    const relevant = document.getAnimations().filter(animation => {
      const target = animation.effect?.target;
      return animation.effect?.getTiming().iterations !== Infinity && target && target.checkVisibility?.({contentVisibilityAuto: true}) !== false;
    });
    await Promise.allSettled(relevant.map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function visit(page, steps) {
  for (const [op, selector, value] of steps) {
    if (op === 'request') await page.evaluate(view => { activateHostWorkspace('request'); activateRequestSubview(view); }, selector);
    else if (op === 'click') { await page.waitForFunction(s => document.querySelector(s), selector); await page.evaluate(s => document.querySelector(s).click(), selector); }
    else if (op === 'fill') { await page.waitForFunction(s => document.querySelector(s), selector);
      await page.evaluate(([s, v]) => { const n = document.querySelector(s); n.value = v; n.dispatchEvent(new Event('input', {bubbles: true})); }, [selector, value]); }
    else if (op === 'wait') await page.waitForFunction(s => [...document.querySelectorAll(s)].some(n => n.getClientRects().length), selector);
    await settle(page);
  }
  // Let fitted capacity commit before measuring: pagers must not be busy.
  await page.waitForFunction(() => [...document.querySelectorAll('.result-pager')].filter(p => p.getClientRects().length).every(p => p.getAttribute('aria-busy') !== 'true'));
  await settle(page);
}

async function openSession(t, browser, layout) {
  const running = await host(layout.kind);
  const context = await browser.newContext({viewport: {width: layout.viewport[0], height: layout.viewport[1]},
    hasTouch: Boolean(layout.touch), isMobile: Boolean(layout.remote), locale: 'zh-CN'});
  t.after(() => context.close());
  await context.addCookies([...running.cookies].map(([n, v]) => ({name: n, value: v, url: running.base})));
  await context.addInitScript(({mobile, keyboard}) => {
    // G11 dock/IME fixture (as mobile_host_browser): a mutable visualViewport the test resizes explicitly.
    if (keyboard) Object.defineProperty(window, 'visualViewport', {configurable: true,
      value: Object.assign(new EventTarget(), {height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1})});
    localStorage.setItem('bilikara.update.automatic', 'false'); localStorage.setItem('bilikara.ui.language', 'zh');
    if (mobile) window.BilikaraHostWindow = {postMessage(raw) { if (['enter', 'exit'].includes(raw)) return; const {id} = JSON.parse(raw);
      queueMicrotask(() => this.onmessage({data: JSON.stringify({id, ok: true, data: {layout: 'auto', orientation: 'system'}})})); }};
    // G10 evidence: every data-page-size value each pager ever holds, from the first paint onward.
    window.__pageSizeHistory = new Map();
    const remember = (node, value) => {
      if (!node.matches?.('.result-pager')) return;
      const list = window.__pageSizeHistory.get(node) || [];
      if (value !== null && list.at(-1) !== value) list.push(value);
      window.__pageSizeHistory.set(node, list);
    };
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') { remember(record.target, record.oldValue); remember(record.target, record.target.getAttribute('data-page-size')); }
        for (const node of record.addedNodes || []) if (node.nodeType === 1) {
          for (const pager of [node, ...node.querySelectorAll?.('.result-pager') || []]) remember(pager, pager.getAttribute?.('data-page-size') ?? null);
        }
      }
    }).observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ['data-page-size'], attributeOldValue: true});
  }, {mobile: layout.kind === 'alpha', keyboard: Boolean(layout.keyboard)});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== running.base) return route.abort();
    // iOS tablets reuse the Android alpha Host with the platform marker iOS ships (as ios_output_ui does).
    if (layout.platform && url.pathname === '/') {
      const response = await route.fetch();
      return route.fulfill({response, body: (await response.text()).replace('data-host-platform="android"', `data-host-platform="${layout.platform}"`)});
    }
    const cover = /^\/grid-covers\/(\d)\.svg$/.exec(url.pathname);
    if (cover) return route.fulfill({body: covers[Number(cover[1])], contentType: 'image/svg+xml'});
    const data = fixtureApi(url);
    return data ? route.fulfill({json: {ok: true, data}}) : route.continue();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(running.base + (layout.remote ? '/remote' : '/'));
  await page.waitForFunction(() => typeof state !== 'undefined' && state.data);
  if (layout.remote) {
    if (!await page.evaluate(async () => { await fetchRemoteIdentity(); return Boolean(state.remoteIdentity?.registered); })) {
      await settle(page);
      await page.locator('#remote-identity-input').fill(`Grid ${++remoteDevices}`);
      await page.locator('#remote-identity-submit').click();
      await page.waitForFunction(() => state.remoteIdentity?.registered);
    }
    await page.locator('#remote-identity-modal').waitFor({state: 'hidden'});
  }
  await settle(page);
  return {page, errors};
}

// The visible grid of the active page and its geometry.
function measureGrid(card) {
  const shown = n => n.getClientRects().length && n.checkVisibility?.({visibilityProperty: true, opacityProperty: true}) !== false;
  const onScreen = n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < innerWidth; };
  const cards = [...document.querySelectorAll(card)].filter(n => shown(n) && onScreen(n));
  if (!cards.length) return null;
  const grid = cards[0].parentElement, style = getComputedStyle(grid);
  const ownCards = cards.filter(n => n.parentElement === grid);
  const own = ownCards.map(n => { const r = n.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; });
  const titles = ownCards.map(n => n.querySelector('.search-result-title')).filter(Boolean)
    .map(n => ({text: n.textContent, h: +n.getBoundingClientRect().height.toFixed(1), owner: Boolean(n.parentElement.querySelector('.search-result-owner'))}));
  const pager = grid.closest('.android-result-frame,.source-mode-panel,.request-mode-panel,.remote-search-browser-view,.remote-request-view')?.querySelector('.result-pager');
  const history = pager && window.__pageSizeHistory?.get(pager);
  return {grid: grid.id || grid.className, columns: new Set(own.map(r => Math.round(r.x))).size, cardWidths: [...new Set(own.map(r => +r.w.toFixed(1)))],
    heights: own.map(r => +r.h.toFixed(1)), rowGap: style.rowGap, columnGap: style.columnGap, count: own.length,
    innerWidth: grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    pageSize: pager?.dataset.pageSize ?? null, sizeHistory: history ? [...history] : null, titles,
    hostColumns: document.documentElement.dataset.hostColumns, hostLayout: document.documentElement.dataset.hostLayout};
}

const engines = [chromium, webkit];
const songPages = ['search-results', 'name-results', 'uid-detail', 'favorites-detail'];

// ---------- G8: two-column tablets keep two song columns ----------
for (const engine of engines) for (const platform of ['android', 'ios']) for (const [width, height] of [[1180, 820], [1024, 768]]) {
  test(`${engine.name()} ${platform === 'ios' ? 'iOS ' : ''}tablet ${width}x${height} two-column song grids keep at least two columns [B2 G8]`, {skip: !linux, timeout: 180000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    for (const name of songPages) {
      const {page, errors} = await openSession(t, browser, {kind: 'alpha', viewport: [width, height], touch: true, platform: platform === 'ios' ? 'ios' : null});
      assert.equal(await page.evaluate(() => document.documentElement.dataset.hostPlatform), platform);
      await visit(page, pages[name].host);
      const grid = await page.evaluate(measureGrid, pages[name].card);
      assert.equal(grid.hostColumns, 'two', `${name}: the tablet uses the two-column layout`);
      assert.ok(grid.columns >= 2, `${name}: at least two song columns, not ${grid.columns}: ` + JSON.stringify(grid));
      assert.ok(Math.min(...grid.cardWidths) >= 176, `${name}: cards keep the phone song width or more: ` + JSON.stringify(grid));
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

for (const engine of engines) {
  test(`${engine.name()} tablet song grids keep two columns across the two-column admission boundary [B2 G8]`, {skip: !linux, timeout: 240000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    const {page, errors} = await openSession(t, browser, {kind: 'alpha', viewport: [1180, 820], touch: true});
    await visit(page, pages['search-results'].host);
    const samples = [];
    for (let width = 860; width <= 1180; width += 20) {
      await page.setViewportSize({width, height: 820});
      if (await page.evaluate(() => document.documentElement.dataset.hostColumns) === 'two') {
        await page.evaluate(() => activateHostWorkspace('request'));
      }
      await settle(page);
      const grid = await page.evaluate(measureGrid, '.search-result-item');
      samples.push({width, ...grid});
      if (grid?.hostColumns === 'two') {
        assert.ok(grid.columns >= 2, `${width}x820 two-column layout keeps two song columns: ` + JSON.stringify(grid));
        assert.ok(Math.min(...grid.cardWidths) >= 176, `${width}x820 cards keep the phone song width or more: ` + JSON.stringify(grid));
      }
    }
    assert.ok(samples.some(sample => sample?.hostColumns === 'two'), 'the sweep reaches the two-column layout: ' + JSON.stringify(samples.map(s => [s.width, s?.hostColumns])));
    assert.ok(samples.some(sample => sample?.hostColumns !== 'two'), 'the sweep crosses the two-column admission boundary: ' + JSON.stringify(samples.map(s => [s.width, s?.hostColumns])));
    assert.deepEqual(errors, []);
  });
}

for (const engine of engines) {
  test(`${engine.name()} desktop song grids keep their 200px admission and column counts [B2 G8]`, {skip: !linux, timeout: 180000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    for (const [width, height] of [[1440, 900], [700, 800]]) for (const name of songPages) {
      const {page, errors} = await openSession(t, browser, {kind: 'desktop', viewport: [width, height]});
      await visit(page, pages[name].host);
      const grid = await page.evaluate(measureGrid, pages[name].card);
      assert.equal(grid.columns, 2, `${width}x${height} ${name}: desktop keeps two song columns: ` + JSON.stringify(grid));
      assert.ok(Math.min(...grid.cardWidths) >= 200, `${width}x${height} ${name}: desktop cards keep the 200px minimum: ` + JSON.stringify(grid));
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

// ---------- G10: a single page-capacity commit per pager ----------
const capacityLayouts = [
  {id: 'phone-393x844', kind: 'alpha', viewport: [393, 844], touch: true},
  {id: 'tablet-1180x820', kind: 'alpha', viewport: [1180, 820], touch: true},
];
for (const engine of engines) for (const layout of capacityLayouts) {
  test(`${engine.name()} ${layout.id} result pagers commit page capacity once [B2 G10]`, {skip: !linux, timeout: 240000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    for (const name of [...songPages, 'source-list']) {
      const {page, errors} = await openSession(t, browser, layout);
      await visit(page, pages[name].host);
      const grid = await page.evaluate(measureGrid, pages[name].card);
      assert.ok(grid.sizeHistory && grid.sizeHistory.length >= 1, `${name}: the pager committed a page size: ` + JSON.stringify(grid));
      // One authority: the first committed capacity is already the fitted one (no 12 -> 15 or 6 -> 3 flash).
      assert.deepEqual(grid.sizeHistory, [grid.pageSize], `${name}: a single page-size commit, not ${JSON.stringify(grid.sizeHistory)}`);
      assert.equal(Number(grid.pageSize), grid.count, `${name}: the committed capacity matches the rendered cards`);
      if (name === 'search-results') {
        // A refresh passes through empty loading; the fitted capacity stays committed (no fallback in between).
        await page.evaluate(() => document.querySelector('#shared-search-button').click());
        await page.waitForFunction(() => [...document.querySelectorAll('#shared-search-results .search-result-item')].some(n => n.getClientRects().length));
        await visit(page, []);
        const again = await page.evaluate(measureGrid, pages[name].card);
        assert.deepEqual(again.sizeHistory, grid.sizeHistory, `${name}: refresh keeps the single commit, not ${JSON.stringify(again.sizeHistory)}`);
        assert.equal(again.pageSize, grid.pageSize, `${name}: refresh keeps the fitted capacity`);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

for (const engine of engines) {
  test(`${engine.name()} Remote keeps its documented page sizes with one commit [B2 G10]`, {skip: !linux, timeout: 180000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    // AGENTS §5.8: Remote keeps document flow and up to twelve UP/favorites entries per page; Remote search keeps the
    // pager default of six (result-pagination.js) and source-detail songs keep remote.js's twelve.
    for (const [name, size] of [['search-results', '6'], ['source-list', '12'], ['favorites-detail', '12']]) {
      const {page, errors} = await openSession(t, browser, {kind: 'desktop', viewport: [393, 844], touch: true, remote: true});
      await visit(page, pages[name].remote);
      const grid = await page.evaluate(measureGrid, pages[name].card);
      assert.equal(grid.pageSize, size, `${name}: Remote page size`);
      assert.deepEqual(grid.sizeHistory, [size], `${name}: a single page-size commit, not ${JSON.stringify(grid.sizeHistory)}`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

// A panel whose fit region has no height (short landscape, B2-G9 geometry still open) must not wait forever:
// the pager settles and the list still shows its entries. G9's own layout assertions remain skipped elsewhere.
for (const engine of engines) {
  test(`${engine.name()} 844x393 source lists still render a page when the fit region has no height [B2 G10]`, {skip: !linux, timeout: 180000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    for (const [mode, card] of [['uids', '#follow-up-grid [data-uid]'], ['favorites', '#favlist-grid [data-folder-id]']]) {
      const {page, errors} = await openSession(t, browser, {kind: 'alpha', viewport: [844, 393], touch: true});
      await page.evaluate(() => { activateHostWorkspace('request'); activateRequestSubview('sources'); });
      await page.evaluate(m => document.querySelector(`[data-sources-mode="${m}"]`).click(), mode);
      await page.waitForFunction(s => document.querySelectorAll(s).length >= 2, card, {timeout: 10000}).catch(() => {});
      const shown = await page.evaluate(s => {
        const pager = [...document.querySelectorAll('.result-pager')].find(p => p.getClientRects().length);
        return {cards: document.querySelectorAll(s).length, busy: pager?.getAttribute('aria-busy') ?? null, pageSize: pager?.dataset.pageSize ?? null};
      }, card);
      assert.ok(shown.cards >= 2, `${mode}: source entries render, not ${JSON.stringify(shown)}`);
      assert.notEqual(shown.busy, 'true', `${mode}: the pager settles: ${JSON.stringify(shown)}`);
      assert.ok(Number(shown.pageSize) >= 1, `${mode}: a page size is committed: ${JSON.stringify(shown)}`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

// ---------- G12: equal song-card heights within one grid ----------
const heightLayouts = [
  {id: 'desktop-1440x900', kind: 'desktop', viewport: [1440, 900]},
  {id: 'desktop-700x800', kind: 'desktop', viewport: [700, 800]},
  {id: 'phone-393x844', kind: 'alpha', viewport: [393, 844], touch: true},
  {id: 'remote-393x844', kind: 'desktop', viewport: [393, 844], touch: true, remote: true},
  {id: 'remote-360x740', kind: 'desktop', viewport: [360, 740], touch: true, remote: true},
];
for (const engine of engines) for (const layout of heightLayouts) {
  test(`${engine.name()} ${layout.id} song cards share one height within each grid [B2 G12]`, {skip: !linux, timeout: 180000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    for (const name of songPages) {
      const {page, errors} = await openSession(t, browser, layout);
      await visit(page, layout.remote ? pages[name].remote : pages[name].host);
      const grid = await page.evaluate(measureGrid, pages[name].card);
      const spread = Math.max(...grid.heights) - Math.min(...grid.heights);
      assert.ok(spread <= 0.5, `${name}: one card height per grid, not ${JSON.stringify([...new Set(grid.heights)])}`);
      // Mixed titles and missing owners: the equal height comes from fixed tracks, not from cutting title text.
      assert.ok(grid.titles.some(title => title.owner) && grid.titles.some(title => !title.owner), `${name}: the page mixes owner and missing-owner cards`);
      assert.ok(grid.titles.every(title => songs.some(song => song.title === title.text)), `${name}: every card keeps its complete title text`);
      assert.equal(new Set(grid.titles.map(title => title.h)).size, 1, `${name}: one title box height, not ${JSON.stringify(grid.titles.map(title => title.h))}`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

// ---------- G13: Host phone and Remote share SongGrid and CompactGrid gaps ----------
for (const engine of engines) {
  test(`${engine.name()} SongGrid and CompactGrid gaps match between the phone Host and Remote [B2 G13]`, {skip: !linux, timeout: 180000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    const gaps = {};
    for (const [client, layout] of [['host', {kind: 'alpha', viewport: [393, 844], touch: true}], ['remote', {kind: 'desktop', viewport: [393, 844], touch: true, remote: true}]]) {
      for (const [role, name] of [['song', 'search-results'], ['compact', 'source-list']]) {
        const {page, errors} = await openSession(t, browser, layout);
        await visit(page, client === 'remote' ? pages[name].remote : pages[name].host);
        const grid = await page.evaluate(measureGrid, pages[name].card);
        gaps[`${client}-${role}`] = [grid.rowGap, grid.columnGap];
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
    assert.deepEqual(gaps['host-song'], gaps['remote-song'], 'SongGrid row/column gaps match: ' + JSON.stringify(gaps));
    assert.deepEqual(gaps['host-compact'], gaps['remote-compact'], 'CompactGrid row/column gaps match: ' + JSON.stringify(gaps));
  });
}

// ---------- G13 rework (N1): desktop Host keeps Preview 2 spacing; native tablets and Remote keep 8/10 ----------
const gapCases = [
  {id: 'desktop-1440x900', layout: {kind: 'desktop', viewport: [1440, 900]}, song: '10px', compact: '10px'},
  {id: 'desktop-761x800', layout: {kind: 'desktop', viewport: [761, 800]}, song: '10px', compact: '10px'},
  {id: 'desktop-760x800', layout: {kind: 'desktop', viewport: [760, 800]}, song: '10px', compact: '10px'},
  {id: 'desktop-700x800', layout: {kind: 'desktop', viewport: [700, 800]}, song: '10px', compact: '10px'},
  {id: 'android-tablet-1180x820', layout: {kind: 'alpha', viewport: [1180, 820], touch: true}, song: '8px', compact: '10px'},
  {id: 'ios-tablet-1024x768', layout: {kind: 'alpha', viewport: [1024, 768], touch: true, platform: 'ios'}, song: '8px', compact: '10px'},
  {id: 'remote-393x844', layout: {kind: 'desktop', viewport: [393, 844], touch: true, remote: true}, song: '8px', compact: '10px'},
];
for (const engine of engines) {
  test(`${engine.name()} desktop Host keeps Preview 2 grid gaps while native tablets and Remote keep the shared tokens [B2 G13]`, {skip: !linux, timeout: 300000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    for (const sample of gapCases) for (const [role, name] of [['song', 'search-results'], ['compact', 'source-list']]) {
      const {page, errors} = await openSession(t, browser, sample.layout);
      await visit(page, sample.layout.remote ? pages[name].remote : pages[name].host);
      const grid = await page.evaluate(measureGrid, pages[name].card);
      assert.deepEqual([grid.rowGap, grid.columnGap], [sample[role], sample[role]], `${sample.id} ${role} grid gap: ` + JSON.stringify(grid));
      if (role === 'song' && sample.layout.kind === 'desktop' && !sample.layout.remote) {
        // Column count follows the unchanged 200px auto-fill admission at the measured width and gap.
        const admitted = Math.max(1, Math.floor((grid.innerWidth + parseFloat(grid.columnGap)) / (200 + parseFloat(grid.columnGap))));
        assert.equal(grid.columns, admitted, `${sample.id}: desktop column count follows the 200px admission: ` + JSON.stringify(grid));
        assert.ok(Math.min(...grid.cardWidths) >= 200, `${sample.id}: desktop keeps the 200px admission: ` + JSON.stringify(grid));
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

// ---------- G9: short landscape phones scroll the whole tool panel through one owner ----------
// The visible request panel's overflowing vertical scrollers (document, ancestors of its cards and anything inside
// the panel), the TopSlot, a complete first row and pager reachability at the end of that single owner.
function g9Probe(card) {
  const shown = n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
  const cards = [...document.querySelectorAll(card)].filter(shown);
  const first = cards[0], panel = first?.closest('.request-mode-panel,.source-mode-panel,.request-subview');
  const result = {cards: cards.length};
  if (!first) return result;
  const pager = [...panel.querySelectorAll('.result-pager')].find(shown) || null;
  const scrolls = n => n === document.scrollingElement ? n.scrollHeight > innerHeight + 1
    : /(auto|scroll|overlay)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1;
  const related = n => n === document.scrollingElement || n.contains(first) || panel.contains(n);
  const owners = [document.scrollingElement, ...document.querySelectorAll('*')].filter(n => n && shown(n) && related(n) && scrolls(n));
  const name = n => n === document.scrollingElement ? 'document' : n.id ? '#' + n.id : n.tagName.toLowerCase() + '.' + [...n.classList].join('.');
  result.owners = owners.map(name);
  const top = panel.querySelector('.browse-search-bar,.source-action-row,.source-uid-form,form');
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:env(safe-area-inset-bottom,0px);';
  document.body.append(probe); const safe = probe.getBoundingClientRect().height; probe.remove();
  const dock = document.getElementById('android-host-dock'), dockRect = dock && shown(dock) ? dock.getBoundingClientRect() : null;
  const floor = Math.min(innerHeight - safe, dockRect && dockRect.height && dockRect.top > innerHeight / 2 ? dockRect.top : Infinity);
  result.floor = floor;
  if (owners.length !== 1) return result;
  const owner = owners[0];
  const visible = () => { const r = owner === document.scrollingElement ? {top: 0, bottom: innerHeight} : owner.getBoundingClientRect();
    return {top: Math.max(0, r.top), bottom: Math.min(r.bottom, floor)}; };
  result.containsTop = Boolean(top && owner.contains(top));
  result.containsPager = Boolean(pager && owner.contains(pager));
  result.containsCards = owner.contains(first);
  // First row: scroll it into the owner's visible box and require every card of that row to fit completely.
  owner.scrollTop = 0; first.scrollIntoView({block: 'nearest'});
  const box = visible(), rowTop = first.getBoundingClientRect().top;
  const row = cards.filter(n => Math.abs(n.getBoundingClientRect().top - rowTop) < 1).map(n => n.getBoundingClientRect());
  result.row = {count: row.length, top: Math.min(...row.map(r => r.top)), bottom: Math.max(...row.map(r => r.bottom)), box};
  result.rowFits = row.length > 0 && row.every(r => r.top >= box.top - 1 && r.bottom <= box.bottom + 1);
  // Pager: scroll the single owner to its end; the pager stays inside the visible box and its buttons hit-test.
  owner.scrollTop = owner.scrollHeight;
  if (pager) {
    const p = pager.getBoundingClientRect(), end = visible();
    result.pager = {top: p.top, bottom: p.bottom, box: end};
    result.pagerFits = p.top >= end.top - 1 && p.bottom <= end.bottom + 1;
    result.pagerHits = [...pager.querySelectorAll('button')].filter(b => b.getClientRects().length).every(b => {
      const r = b.getBoundingClientRect(); return pager.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
  }
  owner.scrollTop = 0;
  return result;
}
const g9Pages = ['source-list', 'uid-detail', 'favorites-list', 'favorites-detail', 'search-results', 'name-tags', 'name-results', 'artist-tags', 'artist-results'];
for (const engine of engines) {
  test(`${engine.name()} 844x393 request pages scroll through one whole-panel owner [B2 G9]`, {skip: !linux, timeout: 360000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    for (const name of g9Pages) {
      const {page, errors} = await openSession(t, browser, {kind: 'alpha', viewport: [844, 393], touch: true});
      await visit(page, pages[name].host);
      const g = await page.evaluate(g9Probe, pages[name].card), label = `${name}: ` + JSON.stringify(g);
      assert.equal(g.owners?.length, 1, `${name}: exactly one overflowing vertical owner, no nesting: ${JSON.stringify(g.owners)}`);
      assert.equal(Boolean(g.containsCards && g.containsTop && g.containsPager), true, 'the owner scrolls the whole panel (TopSlot, cards, pager): ' + label);
      assert.equal(g.rowFits, true, 'at least one complete card row is fully visible: ' + label);
      assert.equal(g.pagerFits, true, 'the pager is reachable at the bottom, clear of the dock and safe area: ' + label);
      assert.equal(g.pagerHits, true, 'pager buttons are hittable: ' + label);
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

// ---------- G11: fit cache keys and invalidation follow every layout change ----------
// After each change settles, the last BilikaraResultPager.diagnostics() entry must describe the visible pager's
// measured fit box, grid and card, and the committed data-page-size; each change commits at most once, never back.
// 200% text uses the repository's root font-size convention (32px); it cannot reproduce Android WebView textZoom.
function pagerFacts([card, sourceFit]) {
  const shown = n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
  const cards = [...document.querySelectorAll(card)].filter(shown), first = cards[0];
  if (!first) return {missing: true, hostLayout: document.documentElement.dataset.hostLayout, columnsMode: document.documentElement.dataset.hostColumns,
    present: document.querySelectorAll(card).length, viewport: [innerWidth, innerHeight]};
  // Song pagers fit their own result viewport (fit:true); the source list fits its bounded source scroller.
  const grid = first.parentElement, fit = sourceFit ? grid.closest('.source-browse-scroll') : grid.closest('.result-page-viewport');
  const pager = [...document.querySelectorAll('.result-pager')].find(p => shown(p) && p.closest('.android-result-frame,.source-mode-panel,.request-mode-panel')?.contains(grid));
  const style = getComputedStyle(grid), cardStyle = getComputedStyle(first);
  const last = window.BilikaraResultPager.diagnostics().at(-1);
  return {last, pageSize: Number(pager?.dataset.pageSize), history: [...(window.__pageSizeHistory.get(pager) || [])],
    rendered: cards.filter(n => n.parentElement === grid).length,
    fit: fit ? {width: fit.clientWidth, height: fit.clientHeight} : null, columns: style.gridTemplateColumns.split(' ').length,
    gap: parseFloat(style.rowGap) || 0, itemHeight: parseFloat(cardStyle.height),
    // A whole-panel scroll owner records its natural height but fits minimum rows (height 1), as documented in B2 step 5.
    fitted: last ? window.BilikaraResultPager.fittedPageSize({...last, height: last.scrollOwner === 'panel' ? 1 : Math.max(1, last.height)}) : null};
}
async function g11Check(page, card, label, before, sourceFit) {
  await settle(page);
  await page.waitForFunction(() => [...document.querySelectorAll('.result-pager')].filter(p => p.getClientRects().length).every(p => p.getAttribute('aria-busy') !== 'true'));
  await settle(page);
  const f = await page.evaluate(pagerFacts, [card, Boolean(sourceFit)]), text = `${label}: ` + JSON.stringify({...f, before});
  assert.ok(!f.missing, 'the page still shows its cards: ' + text);
  assert.ok(f.last && f.fit, 'diagnostics recorded a measurement for a measured fit box: ' + text);
  assert.equal(f.last.size, f.pageSize, 'diagnostics size is the committed page size: ' + text);
  assert.equal(f.last.columns, f.columns, 'diagnostics columns match the grid: ' + text);
  assert.ok(Math.abs(f.last.width - f.fit.width) <= 1 && Math.abs(f.last.height - f.fit.height) <= 1, 'diagnostics fit box matches the measured fit element: ' + text);
  assert.ok(Math.abs(f.last.gap - f.gap) <= 0.5, 'diagnostics gap matches the grid: ' + text);
  assert.ok(Math.abs(f.last.itemHeight - f.itemHeight) <= 1, 'diagnostics item height matches a rendered card: ' + text);
  assert.equal(f.fitted, f.pageSize, 'the committed size is the fit of the recorded geometry: ' + text);
  assert.equal(f.rendered, f.pageSize, 'the page renders exactly its committed capacity: ' + text);
  if (before) {
    const added = f.history.slice(before.length);
    assert.ok(added.length <= 1, 'one commit per change, no intermediate fallback: ' + text);
    assert.ok(!added.length || added[0] !== before.at(-1), 'a change never re-commits the same value: ' + text);
  }
  return f.history;
}
for (const engine of engines) for (const name of ['uid-detail', 'source-list']) {
  test(`${engine.name()} ${name} fit diagnostics follow font, rotation, IME, dock, toolbar and re-entry [B2 G11]`, {skip: !linux, timeout: 300000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    const {page, errors} = await openSession(t, browser, {kind: 'alpha', viewport: [393, 844], touch: true, keyboard: true});
    await visit(page, pages[name].host);
    const card = name === 'source-list' ? '#follow-up-grid > *' : pages[name].card, sourceFit = name === 'source-list';
    let history = await g11Check(page, card, 'initial', null, sourceFit);
    const step = async (label, fn) => { await page.evaluate(fn); history = await g11Check(page, card, label, history, sourceFit); };
    await step('font 200%', () => { document.documentElement.style.fontSize = '32px'; });
    await step('font 100%', () => { document.documentElement.style.fontSize = ''; });
    // Text zoom can grow a card's border box without changing its font properties (the stale-cache case).
    const cardRule = name === 'source-list' ? '#follow-up-grid > *' : '.search-result-item';
    await step('card border box grows', new Function(`const s = document.createElement('style'); s.id = 'g11-card'; s.textContent = '${cardRule} { padding-bottom: 24px !important; min-height: 0 !important; }'; document.head.append(s);`));
    await step('card border box restored', () => document.getElementById('g11-card').remove());
    for (const [width, height] of [[844, 393], [393, 844]]) {
      await page.setViewportSize({width, height});
      await page.evaluate(([w, h]) => { Object.assign(visualViewport, {width: w, height: h}); visualViewport.dispatchEvent(new Event('resize')); }, [width, height]);
      // A compact landscape overlay starts closed after the layout change; reopen the Request sheet as a user would.
      await settle(page);
      if (!await page.evaluate(card => [...document.querySelectorAll(card)].some(n => n.getClientRects().length), card)) {
        await page.evaluate(() => activateHostWorkspace('request'));
        await page.waitForFunction(card => [...document.querySelectorAll(card)].some(n => n.getClientRects().length), card, {timeout: 10000}).catch(() => {});
      }
      history = await g11Check(page, card, `rotate ${width}x${height}`, history, sourceFit);
    }
    await step('IME open', () => { visualViewport.height = 520; visualViewport.dispatchEvent(new Event('resize')); });
    await step('IME close', () => { visualViewport.height = innerHeight; visualViewport.dispatchEvent(new Event('resize')); });
    await step('dock taller', () => { const d = document.getElementById('android-host-dock'); d.dataset.g11Height = d.style.height; d.style.height = (d.getBoundingClientRect().height + 40) + 'px'; });
    await step('dock restored', () => { const d = document.getElementById('android-host-dock'); d.style.height = d.dataset.g11Height || ''; });
    if (name === 'uid-detail') {
      await step('toolbar shown', () => document.querySelector('#follow-search-form').parentElement.querySelector('.browse-search-cancel').click());
      await step('toolbar hidden', () => document.querySelector('#follow-search-form').parentElement.querySelector('.browse-search-cancel').click());
      await page.evaluate(() => document.querySelector('#follow-browse-back').click());
      await page.waitForFunction(() => [...document.querySelectorAll('#follow-up-grid [data-uid]')].some(n => n.getClientRects().length));
      await page.evaluate(() => document.querySelector('#follow-up-grid [data-uid]').click());
      await page.waitForFunction(() => [...document.querySelectorAll('#follow-song-results .search-result-item')].some(n => n.getClientRects().length));
    } else {
      await page.evaluate(() => activateRequestSubview('search'));
      await settle(page);
      await page.evaluate(() => activateRequestSubview('sources'));
      await page.waitForFunction(() => [...document.querySelectorAll('#follow-up-grid [data-uid]')].some(n => n.getClientRects().length));
    }
    await g11Check(page, card, 're-entered', history, sourceFit);
    assert.deepEqual(errors, []);
  });
}

// ---------- G9 admission boundary: whole-panel mode never flaps around the one-row threshold ----------
// Sweeps a landscape phone's height up and back down through the compact-overlay range. At every height the
// owner mode and page size stay constant for 30 frames, the mode changes once per direction, both directions
// agree at each height, and a bounded (non-panel) layout really fits one complete row inside its inner owner.
for (const engine of engines) for (const name of ['source-list', 'uid-detail']) {
  test(`${engine.name()} ${name} whole-panel admission is stable across the one-row boundary [B2 G9 R1]`, {skip: !linux, timeout: 360000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    const {page, errors} = await openSession(t, browser, {kind: 'alpha', viewport: [844, 393], touch: true});
    await visit(page, pages[name].host);
    const card = name === 'source-list' ? '#follow-up-grid > *' : pages[name].card;
    const heights = Array.from({length: 46}, (_, i) => 300 + i * 6), modes = {up: new Map(), down: new Map()};
    for (const [direction, list] of [['up', heights], ['down', [...heights].reverse()]]) {
      for (const height of list) {
        await page.setViewportSize({width: 844, height});
        await settle(page);
        if (!await page.evaluate(card => [...document.querySelectorAll(card)].some(n => n.getClientRects().length), card)) {
          await page.evaluate(() => activateHostWorkspace('request'));
          await page.waitForFunction(card => [...document.querySelectorAll(card)].some(n => n.getClientRects().length), card, {timeout: 10000}).catch(() => {});
          await settle(page);
        }
        const sample = await page.evaluate(async card => {
          const ws = document.getElementById('host-workspace-request'), frames = [];
          for (let i = 0; i < 30; i++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const pager = [...document.querySelectorAll('.result-pager')].find(p => p.getClientRects().length);
            frames.push(`${ws.getAttribute('data-result-scroll-owner') || 'bounded'}:${pager?.dataset.pageSize}`);
          }
          const first = [...document.querySelectorAll(card)].find(n => n.getClientRects().length);
          const owner = first && (first.closest('.source-browse-scroll') || first.closest('.result-page-viewport'));
          const r = first?.getBoundingClientRect(), o = owner?.getBoundingClientRect();
          return {frames: [...new Set(frames)], flips: frames.filter((v, i) => i && v !== frames[i - 1]).length,
            mode: ws.getAttribute('data-result-scroll-owner') || 'bounded', candidate: getComputedStyle(ws).getPropertyValue('--result-page-panel-scroll-candidate').trim(),
            rowFits: Boolean(r && o && r.height <= o.height + 1), card: r && Math.round(r.height), owner: o && Math.round(o.height)};
        }, card);
        const label = `${direction} ${height}: ` + JSON.stringify(sample);
        assert.equal(sample.flips, 0, 'owner mode and page size stay constant for 30 frames: ' + label);
        if (sample.mode !== 'panel') assert.ok(sample.rowFits, 'a bounded layout fits one complete row in its inner owner: ' + label);
        else assert.equal(sample.candidate, '1', 'panel mode only inside the compact-overlay candidate: ' + label);
        modes[direction].set(height, sample.mode);
      }
    }
    for (const [direction, list] of [['up', heights], ['down', [...heights].reverse()]]) {
      const sequence = list.map(h => modes[direction].get(h));
      const changes = sequence.filter((m, i) => i && m !== sequence[i - 1]).length;
      assert.ok(changes <= 1, `${direction}: the mode changes at most once across the sweep: ` + JSON.stringify(list.map((h, i) => [h, sequence[i]])));
    }
    const disagree = heights.filter(h => modes.up.get(h) !== modes.down.get(h));
    assert.deepEqual(disagree, [], 'both directions choose the same mode at each height: ' + JSON.stringify(heights.map(h => [h, modes.up.get(h), modes.down.get(h)])));
    assert.ok(new Set(modes.up.values()).has('panel'), 'the sweep reaches whole-panel mode: ' + JSON.stringify([...modes.up]));
    assert.ok(new Set(modes.up.values()).has('bounded'), 'the sweep reaches the bounded layout: ' + JSON.stringify([...modes.up]));
    assert.deepEqual(errors, []);
  });
}
