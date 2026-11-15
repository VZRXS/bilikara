// Scroll contract (R8 §24 SCROLL-R2-01..05, UI-CONTRACT-08, IOS-R2-04b density; AGENTS §5.1/§5.8).
// Measurement baseline and open product decisions: bilikara-next-10 artifact b3-measure.md (§3 gaps, §4 D1..D5).
// Real Rust Hosts (desktop host and Android alpha) with the shipped static UI. Catalog/source HTTP is answered
// by browser routes; queue/history are seeded in-page after closing SSE, as in mobile_host_browser.test.mjs.
// Headless browsers do not paint Android/iOS overlay indicators: these checks constrain the scroll owner box
// that a native indicator follows. Physical indicator placement remains DEVICE-UNVERIFIED.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {after, before} from 'node:test';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha, buildNativeHost} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

const linux = process.platform === 'linux';
let alphaBinary, desktopBinary;
const hosts = new Map(), homes = [];
let remoteDevices = 0;
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
const songs = Array.from({length: 600}, (_, i) => ({bvid: 'BV' + String(i + 1).padStart(10, '0'),
  title: `Scroll fixture ${i + 1}${i % 3 ? '' : ' with a longer two-line title for wrapping'}`, owner_name: 'Fixture UP', mid: '42',
  duration: 200 + i, cover_url: `/scroll-covers/${i % 2}.svg`, pic: `/scroll-covers/${i % 2}.svg`,
  url: `https://www.bilibili.com/video/BV${String(i + 1).padStart(10, '0')}`}));
const owners = Array.from({length: 61}, (_, i) => ({uid: String(42 + i), name: `测试 UP ${i + 1}`, count: 600 - i, avatar_url: '/pic/icon.png'}));
const folders = owners.map(owner => ({...owner, id: `${owner.uid}:7`, folder_id: '7', media_id: '7', title: `收藏夹 ${owner.uid}`}));
const covers = ['#587ba0', '#a05858'].map(fill => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${fill}"/></svg>`);
function paged(rows, url, limit = 80) {
  const offset = Number(url.searchParams.get('offset') || 0), size = Number(url.searchParams.get('limit') || limit);
  return {items: rows.slice(offset, offset + size), offset, limit: size, matched_count: rows.length,
    has_more: offset + size < rows.length, next_offset: Math.min(offset + size, rows.length)};
}
function fixtureApi(url) {
  const name = url.pathname, query = url.searchParams.get('q') || '';
  if (name === '/api/catalog/search' || name === '/api/gatcha/search') return {...paged(songs, url), query, result_kind: 'songs'};
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
// Each step list leaves the page in a settled state with one content region active.
const pages = {
  my: {host: [['my']], phoneOnly: true},
  settings: {host: [['settings']]},
  queue: {host: [['seed'], ['workspace', 'queue']], remote: [['seed'], ['click', '#queue-view-button']]},
  history: {host: [['seed'], ['workspace', 'history']], remote: [['seed'], ['click', '#history-view-button']]},
  'search-results': {
    host: [['request', 'search'], ['click', '[data-search-mode="shared"]'], ['fill', '#shared-search-query', 'fixture'], ['click', '#shared-search-button'], ['wait', '#shared-search-results .search-result-item']],
    remote: [['click', '[data-remote-request-view="search"]'], ['click', '[data-remote-search-mode="shared"]'], ['fill', '#shared-search-query', 'fixture'], ['click', '#shared-search-button'], ['wait', '#shared-search-results .search-result-item']]},
  'source-list': {
    host: [['request', 'sources'], ['click', '[data-sources-mode="uids"]'], ['wait', '#follow-up-grid [data-uid]']],
    remote: [['click', '[data-remote-request-view="sources"]'], ['click', '[data-remote-sources-mode="uids"]'], ['wait', '#sources-follow-grid [data-uid]']]},
  'source-detail': {
    host: [['request', 'sources'], ['click', '[data-sources-mode="favorites"]'], ['wait', '#favlist-grid [data-folder-id]'], ['click', '#favlist-grid [data-folder-id]'], ['wait', '#favlist-song-results .search-result-item']],
    remote: [['click', '[data-remote-request-view="sources"]'], ['click', '[data-remote-sources-mode="favorites"]'], ['wait', '#favlist-grid [data-folder-id]'], ['click', '#favlist-grid [data-folder-id]'], ['wait', '#remote-sources-favorites-panel .search-result-item']]},
};
const layouts = [
  {id: 'desktop-1440x900', kind: 'desktop', viewport: [1440, 900]},
  {id: 'desktop-700x800', kind: 'desktop', viewport: [700, 800]},
  {id: 'android-393x640', kind: 'alpha', viewport: [393, 640], touch: true},
  {id: 'android-393x844', kind: 'alpha', viewport: [393, 844], touch: true},
  {id: 'tablet-1180x820', kind: 'alpha', viewport: [1180, 820], touch: true},
  {id: 'remote-393x844', kind: 'desktop', viewport: [393, 844], touch: true, remote: true},
];

async function host(kind) {
  if (hosts.has(kind)) return hosts.get(kind);
  const home = mkdtempSync(path.join(tmpdir(), 'bilikara-scroll-contract-')); homes.push(home);
  const statics = path.join(root, 'static');
  const running = kind === 'alpha'
    ? await RunningHost.start(alphaBinary, home, [home, statics], isolatedEnvironment(home), true)
    : await RunningHost.start(desktopBinary, home, ['--headless', '--port', '0', '--data-dir', path.join(home, 'data'), '--static-dir', statics], isolatedEnvironment(home));
  await running.api('/api/session-users/add', {name: 'Scroll singer'});
  hosts.set(kind, running);
  return running;
}

async function settle(page) {
  // Wait only for finite animations on rendered nodes; WebKit can keep unresolved transitions on hidden nodes.
  await page.evaluate(async () => {
    await document.fonts.ready;
    const relevant = document.getAnimations().filter(animation => {
      const target = animation.effect?.target;
      return animation.effect?.getTiming().iterations !== Infinity && target
        && target.checkVisibility?.({contentVisibilityAuto: true}) !== false;
    });
    await Promise.allSettled(relevant.map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function visit(page, steps) {
  for (const [op, selector, value] of steps) {
    if (op === 'request') await page.evaluate(view => { activateHostWorkspace('request'); activateRequestSubview(view); }, selector);
    else if (op === 'my') await page.locator('[data-android-page="my"]').click();
    else if (op === 'settings') await page.evaluate(() => {
      if (document.documentElement.dataset.hostLayout === 'portrait') {
        document.querySelector('[data-android-page="my"]').click(); document.getElementById('android-open-settings').click();
      } else activateHostWorkspace('settings');
    });
    else if (op === 'workspace') await page.evaluate(view => {
      const dock = document.querySelector('[data-android-page="queue"]');
      if (dock?.getClientRects().length) { dock.click(); if (view === 'history') document.querySelector('[data-android-workspace="history"]').click(); }
      else activateHostWorkspace(view);
    }, selector);
    else if (op === 'seed') await page.evaluate(() => {
      fetchState = async () => {}; state.eventSource?.close();
      state.data.playlist = Array.from({length: 30}, (_, i) => ({id: `scroll-${i}`, display_title: `歌曲 ${i + 1}：保持自然高度的两行标题与点歌信息`,
        title: `歌曲 ${i + 1}`, requester_name: 'Scroll singer', cache_status: 'pending'}));
      state.data.history = Array.from({length: 30}, (_, i) => ({display_title: `历史歌曲 ${i + 1}`, title: `历史歌曲 ${i + 1}`, requested_at: 1700000000 + i,
        request_count: 1, requester_name: 'Scroll singer', original_url: `https://www.bilibili.com/video/BV17x411w7KC?p=${i + 1}`}));
      render(); renderHistory(state.data.history);
    });
    else if (op === 'click') { await page.waitForFunction(s => document.querySelector(s), selector); await page.evaluate(s => document.querySelector(s).click(), selector); }
    else if (op === 'fill') { await page.waitForFunction(s => document.querySelector(s), selector);
      await page.evaluate(([s, v]) => { const n = document.querySelector(s); n.value = v; n.dispatchEvent(new Event('input', {bubbles: true})); }, [selector, value]); }
    else if (op === 'wait') await page.waitForFunction(s => [...document.querySelectorAll(s)].some(n => n.getClientRects().length), selector);
    await settle(page);
  }
}

// The same measurement as b3-measure.mjs, reduced to the contract fields.
function measureScroll() {
  const rect = n => { const r = n.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right}; };
  const label = n => n === document.scrollingElement ? 'document' : n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.classList.length ? '.' + [...n.classList].slice(0, 3).join('.') : '');
  const shown = n => n.getClientRects().length && n.checkVisibility?.({visibilityProperty: true, opacityProperty: true}) !== false;
  const onScreen = n => { const r = n.getBoundingClientRect(); return r.right > 1 && r.left < innerWidth - 1 && r.bottom > 1 && r.top < innerHeight - 1; };
  const candidates = [...document.querySelectorAll('body *')].filter(n => /(auto|scroll)/.test(getComputedStyle(n).overflowY)
    && shown(n) && n.clientHeight > 0 && !n.closest('[inert],[hidden],[aria-hidden="true"]') && onScreen(n));
  const doc = document.scrollingElement;
  const dockNode = [...document.querySelectorAll('#android-host-dock,#playback-dock')].find(shown);
  const dock = dockNode ? rect(dockNode) : null;
  const contentSelector = '.search-result-item,.follow-up-button,.source-removal-card,.song-item,.history-item,.android-my-card,.android-menu-row,'
    + '.settings-section,.tag-browser-tag,.category-browser-card,.cache-panel-row,.list > *,button,input,select';
  const owners = candidates.map(node => {
    const style = getComputedStyle(node), box = rect(node);
    const content = [...node.querySelectorAll(contentSelector)].filter(n => shown(n) && n.getBoundingClientRect().width > 0);
    const innerRight = box.x + node.clientLeft + node.clientWidth;
    const contentRight = content.length ? Math.max(...content.map(n => n.getBoundingClientRect().right)) : null;
    const overflow = node.scrollHeight - node.clientHeight;
    let reach = null;
    if (overflow > 1) {
      const before = node.scrollTop; node.scrollTop = node.scrollHeight;
      const bottoms = content.map(n => n.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.bottom);
      const last = bottoms.length ? Math.max(...bottoms) : null;
      const dockLimited = Boolean(dock && box.b > dock.y - 1);
      const visibleBottom = dockLimited ? Math.min(box.b, dock.y) : box.b;
      reach = {last, visibleBottom, dockLimited, clearance: last === null ? null : visibleBottom - last};
      node.scrollTop = before;
    }
    return {el: label(node), box, overflow, scrolls: overflow > 1,
      classicWidth: node.offsetWidth - node.clientWidth - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0),
      gutter: style.scrollbarGutter, rightRoom: contentRight === null ? null : innerRight - contentRight,
      fullWidth: Math.abs(box.x) <= 1 && Math.abs(box.r - innerWidth) <= 1,
      underDock: dock ? box.b - dock.y : null, reach};
  });
  for (const owner of owners) owner.nestedIn = owners.filter(o => o !== owner && o.scrolls
    && candidates[owners.indexOf(o)].contains(candidates[owners.indexOf(owner)])).map(o => o.el);
  const stableIdle = [...document.querySelectorAll('body *')].filter(n => shown(n) && /stable/.test(getComputedStyle(n).scrollbarGutter)
    && n.scrollHeight <= n.clientHeight + 1 && !n.closest('[inert],[hidden],[aria-hidden="true"]')).map(label);
  const groups = sel => [...document.querySelectorAll(sel)].filter(shown).map(n => { const s = getComputedStyle(n); return {el: label(n), box: rect(n), padding: s.padding, radius: s.borderRadius}; });
  return {owners, document: {scrolls: doc.scrollHeight > innerHeight + 1, overflow: doc.scrollHeight - innerHeight},
    dock, stableIdle, myGroups: groups('.android-my-scroll > .android-my-card, .android-my-scroll > .android-menu-row'),
    layout: document.documentElement.dataset.hostLayout, platform: document.documentElement.dataset.hostPlatform};
}

async function openPage(t, browser, layout, name) {
  const running = await host(layout.kind);
  const context = await browser.newContext({viewport: {width: layout.viewport[0], height: layout.viewport[1]},
    hasTouch: Boolean(layout.touch), isMobile: Boolean(layout.remote), locale: 'zh-CN'});
  t.after(() => context.close());
  await context.addCookies([...running.cookies].map(([n, v]) => ({name: n, value: v, url: running.base})));
  await context.addInitScript(mobile => {
    localStorage.setItem('bilikara.update.automatic', 'false'); localStorage.setItem('bilikara.ui.language', 'zh');
    if (mobile) window.BilikaraHostWindow = {postMessage(raw) { if (['enter', 'exit'].includes(raw)) return; const {id} = JSON.parse(raw);
      queueMicrotask(() => this.onmessage({data: JSON.stringify({id, ok: true, data: {layout: 'auto', orientation: 'system'}})})); }};
  }, layout.kind === 'alpha');
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== running.base) return route.abort();
    const cover = /^\/scroll-covers\/(\d)\.svg$/.exec(url.pathname);
    if (cover) return route.fulfill({body: covers[Number(cover[1])], contentType: 'image/svg+xml'});
    const data = fixtureApi(url);
    return data ? route.fulfill({json: {ok: true, data}}) : route.continue();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(running.base + (layout.remote ? '/remote' : '/'));
  await page.waitForFunction(() => typeof state !== 'undefined' && state.data);
  if (layout.remote) {
    // Resolve the identity check first: a context sharing the Host cookies may already be registered, in
    // which case the gate closes again. Register only when Remote reports an unregistered device.
    if (!await page.evaluate(async () => { await fetchRemoteIdentity(); return Boolean(state.remoteIdentity?.registered); })) {
      await settle(page);
      await page.locator('#remote-identity-input').fill(`Scroll ${++remoteDevices}`);
      await page.locator('#remote-identity-submit').click();
      await page.waitForFunction(() => state.remoteIdentity?.registered);
    }
    await page.locator('#remote-identity-modal').waitFor({state: 'hidden'});
  }
  await settle(page);
  await visit(page, layout.remote ? pages[name].remote : pages[name].host);
  const sample = await page.evaluate(measureScroll);
  assert.deepEqual(errors, [], 'page errors');
  return sample;
}

// ---------- static scan ----------
function cssFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? cssFiles(full) : entry.name.endsWith('.css') ? [full] : [];
  });
}
test('no stylesheet reserves a stable scrollbar gutter unconditionally [AGENTS §5.8, b3-measure G6]', () => {
  const offenders = [];
  for (const file of cssFiles(path.join(root, 'static'))) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
      if (!/scrollbar-gutter\s*:\s*stable/.test(match[2])) continue;
      const selector = match[1].trim();
      // A stable gutter is allowed only behind an explicit "actually scrolling" state.
      if (!/\.(is-scrollable|has-scroll-inset)\b/.test(selector)) offenders.push(`${path.relative(root, file)}: ${selector}`);
    }
  }
  assert.deepEqual(offenders, [], 'scrollbar-gutter: stable must depend on an actual overflow state');
});

// ---------- runtime contract ----------
for (const engine of [chromium, webkit]) for (const layout of layouts) {
  test(`${engine.name()} ${layout.id} scroll owners follow the shared contract [SCROLL-R2-01/02/04]`, {skip: !linux, timeout: 300000}, async t => {
    const browser = await engine.launch(layout.kind === 'desktop' && !layout.remote && engine === chromium
      ? {headless: true, ignoreDefaultArgs: ['--hide-scrollbars']} : {headless: true});
    t.after(() => browser.close());
    for (const name of Object.keys(pages)) {
      if (pages[name].phoneOnly && !layout.id.startsWith('android-')) continue;
      if (layout.remote && !pages[name].remote) continue;
      await t.test(name, async st => {
        const sample = await openPage(st, browser, layout, name);
        const scrolling = sample.owners.filter(owner => owner.scrolls);
        const remoteList = layout.remote && ['queue', 'history'].includes(name);

        await st.test('one actually overflowing vertical owner, not nested', {
          todo: remoteList ? 'D2 pending (b3-measure.md §4): Remote queue/history scroll a bounded list inside the scrolling document' : false,
        }, () => {
          const all = scrolling.map(owner => owner.el).concat(sample.document.scrolls ? ['document'] : []);
          if (layout.remote) {
            // Remote keeps document scrolling (AGENTS §5.8); no element owner may scroll in addition.
            assert.deepEqual(scrolling.map(owner => owner.el), [], JSON.stringify(all));
          } else {
            assert.ok(scrolling.length <= 1, 'one owner per page: ' + JSON.stringify(all));
            assert.equal(sample.document.scrolls, false, 'the Host document itself never scrolls');
            for (const owner of scrolling) assert.deepEqual(owner.nestedIn, [], owner.el + ' is not nested in another scrolling owner');
          }
        });

        await st.test('overlay owners keep a right gutter while scrolling [R2-02]', () => {
          for (const owner of scrolling) {
            // A classic scrollbar draws its own track outside the content box.
            if (owner.classicWidth > 0 || owner.rightRoom === null) continue;
            // D5 (b3-measure.md §4) keeps the desktop song grids unchanged. Linux WebKit, like macOS WKWebView,
            // uses overlay scrollbars there, so the indicator can still touch cards: recorded, not enforced.
            if (sample.platform === 'desktop' && /-(search|song)-results$/.test(owner.el)) continue;
            const minimum = owner.fullWidth ? 14 : 4;
            assert.ok(owner.rightRoom >= minimum - 0.5, `${owner.el} right room ${owner.rightRoom} >= ${minimum}: ` + JSON.stringify(owner));
          }
        });

        await st.test('no scrollbar gutter without overflow [AGENTS §5.8]', () => {
          for (const owner of sample.owners.filter(owner => !owner.scrolls)) assert.equal(owner.classicWidth, 0, `${owner.el} reserves no idle gutter`);
          assert.deepEqual(sample.stableIdle, [], 'no rendered element holds a stable gutter while not overflowing');
        });

        await st.test('the final item can be scrolled into view [R2-01]', {
          todo: remoteList ? 'D2 pending (b3-measure.md §4): the bounded Remote list ends below the viewport until the document scrolls' : false,
        }, () => {
          for (const owner of scrolling.filter(owner => owner.reach?.last !== null)) {
            // Owners that reach the dock keep the final item 12px above it (AGENTS §5.1); others show it completely.
            const minimum = owner.reach.dockLimited ? 12 : -1;
            assert.ok(owner.reach.clearance >= minimum, `${owner.el} clearance ${owner.reach.clearance} >= ${minimum}: ` + JSON.stringify(owner.reach));
          }
        });

        await st.test('owners stop at the dock top [D1]', {
          todo: 'D1 pending (b3-measure.md §4): AGENTS §5.1 dock underlap vs SCROLL-R2-01 indicator intersection',
        }, () => {
          for (const owner of scrolling) if (owner.underDock !== null) assert.ok(owner.underDock <= 1, `${owner.el} extends ${owner.underDock}px under the dock`);
        });

        if (name === 'my') await st.test('My groups use 14px gutters, 12px spacing, 14px insets and corners [AGENTS §5.1]', () => {
          const groups = sample.myGroups;
          assert.ok(groups.length >= 3, JSON.stringify(groups));
          for (const group of groups) {
            assert.ok(Math.abs(group.box.x - 14) <= 0.5 && Math.abs(layout.viewport[0] - group.box.r - 14) <= 0.5, `${group.el} keeps 14px page gutters`);
            assert.equal(group.radius, '14px', `${group.el} corner`);
            if (group.el !== '#android-open-settings') assert.equal(group.padding, '14px', `${group.el} inner inset`);
          }
          for (let i = 1; i < groups.length; i++) assert.ok(Math.abs(groups[i].box.y - groups[i - 1].box.b - 12) <= 0.5, `12px between ${groups[i - 1].el} and ${groups[i].el}`);
        });

        if (name === 'settings' && layout.id.startsWith('android-')) await st.test('Settings uses the My group treatment [D4]', {
          todo: 'D4 pending (b3-measure.md §4): Settings headings sit outside 14px-spaced cards; My uses in-card headings and 12px spacing',
        }, async () => {
          assert.fail('awaiting the D4 Settings grouping decision before encoding its geometry');
        });
      });
    }
  });
}

// Remote document scrolling keeps the browser's own indicator, which CSS cannot inset above #playback-dock.
test('Remote document indicator crosses the fixed playback dock [SCROLL-R2-03 G5]', {
  skip: 'ENGINE-LIMITATION (b3-measure.md §0 F5, §4 D3): native document scroll indicators cannot be inset; Remote keeps document scrolling',
}, () => {});
