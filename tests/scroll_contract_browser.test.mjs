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
  const groups = sel => [...document.querySelectorAll(sel)].filter(shown).map(n => {
    const s = getComputedStyle(n), box = rect(n);
    // Nothing inside a group may be cut off by the group's own box.
    const clipped = n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1
      || [...n.querySelectorAll('*')].filter(c => shown(c) && c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().height > 0).some(c => {
        const r = c.getBoundingClientRect(); return r.left < box.x - 0.5 || r.right > box.r + 0.5 || r.top < box.y - 0.5 || r.bottom > box.b + 0.5; });
    const heading = n.querySelector(':scope > .settings-section-heading, :scope > .android-my-section-heading, :scope > h3');
    const headingBox = heading ? rect(heading) : null;
    return {el: label(n), box, padding: s.padding, inline: [s.paddingLeft, s.paddingRight], radius: s.borderRadius, border: s.borderTopWidth,
      filled: s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent', clipped,
      headingInside: headingBox ? headingBox.y >= box.y - 0.5 && headingBox.b <= box.b + 0.5 && headingBox.x >= box.x - 0.5 && headingBox.r <= box.r + 0.5 : null};
  });
  // Remote document reach (D2): scroll the page to its end and compare the final queue/history row with the dock.
  let listReach = null;
  const list = [...document.querySelectorAll('#queue-list,#history-list')].find(shown);
  if (list && list.lastElementChild && dock) {
    // Only the document scrolls: D2 requires the final row without scrolling a nested list first.
    const before = doc.scrollTop; doc.scrollTop = doc.scrollHeight;
    const last = list.lastElementChild.getBoundingClientRect(), dockTop = dockNode.getBoundingClientRect().top;
    listReach = {list: label(list), lastBottom: last.bottom, dockTop, clearance: dockTop - last.bottom};
    doc.scrollTop = before;
  }
  const stage = document.getElementById('list-stage'), current = document.getElementById('queue-current');
  const queueFrame = stage && shown(stage) ? {bottom: stage.getBoundingClientRect().bottom, currentHidden: !current || !shown(current)} : null;
  return {owners, document: {scrolls: doc.scrollHeight > innerHeight + 1, overflow: doc.scrollHeight - innerHeight}, listReach, queueFrame,
    dock, stableIdle, myGroups: groups('.android-my-scroll > .android-my-card, .android-my-scroll > .android-menu-row'),
    settingsGroups: groups('#host-workspace-settings .settings-workspace-body > .settings-section'),
    layout: document.documentElement.dataset.hostLayout, platform: document.documentElement.dataset.hostPlatform};
}

async function openPage(t, browser, layout, name) {
  const {page, errors} = await openSession(t, browser, layout);
  await visit(page, layout.remote ? pages[name].remote : pages[name].host);
  const sample = await page.evaluate(measureScroll);
  assert.deepEqual(errors, [], 'page errors');
  return sample;
}

async function openSession(t, browser, layout) {
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
  return {page, errors};
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

        await st.test('one actually overflowing vertical owner, not nested [R2-04, D2]', () => {
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

        await st.test('the final item can be scrolled into view [R2-01]', () => {
          for (const owner of scrolling.filter(owner => owner.reach?.last !== null)) {
            // Owners that reach the dock keep the final item 12px above it (AGENTS §5.1); others show it completely.
            const minimum = owner.reach.dockLimited ? 12 : -1;
            assert.ok(owner.reach.clearance >= minimum, `${owner.el} clearance ${owner.reach.clearance} >= ${minimum}: ` + JSON.stringify(owner.reach));
          }
        });

        // D2 (decided, b3-measure.md §4): Remote queue/history follow document scrolling as the single owner,
        // and the final row scrolls directly above the fixed playback dock.
        if (remoteList) await st.test('the final Remote row scrolls above the playback dock with the document [D2]', () => {
          assert.ok(sample.listReach, 'a visible queue/history list and playback dock');
          assert.ok(sample.listReach.clearance >= 12, 'document scrolling alone brings the final row 12px above the dock: ' + JSON.stringify(sample.listReach));
        });

        // D1 (decided, b3-measure.md §4): phone My/Settings/Queue/History scrollports end at the dock top, so the
        // native indicator never crosses it; only the background shows behind the dock.
        if (layout.id.startsWith('android-') && ['my', 'settings', 'queue', 'history'].includes(name)) {
          // Without a current song, the Queue grid keeps an empty 1fr track and its 10px gap below #playlist
          // (.host-workspace-region .list-stage, present since 6944f87), so that owner ends 10px early.
          const emptyQueueTrack = name === 'queue' && sample.queueFrame?.currentHidden;
          await st.test('phone page scrollports stop exactly at the dock top [D1]', () => {
            assert.ok(sample.dock, 'the phone dock is rendered');
            const owners = sample.owners.filter(owner => owner.underDock !== null);
            assert.ok(owners.length >= 1, 'the page has a scroll owner: ' + JSON.stringify(sample.owners.map(owner => owner.el)));
            for (const owner of owners) {
              assert.ok(owner.underDock <= 1, `${owner.el} ends at the dock top, not ${owner.underDock}px under it`);
              // Lower bound: the owner must not end early either (wasted space, indicator stopping short).
              if (!(emptyQueueTrack && owner.el === '#playlist')) assert.ok(owner.underDock >= -1, `${owner.el} reaches the dock top, not ${-owner.underDock}px above it`);
            }
            if (name === 'queue') assert.ok(Math.abs(sample.queueFrame.bottom - sample.dock.y) <= 1, 'the Queue frame reaches exactly the dock top: ' + JSON.stringify(sample.queueFrame));
          });
          if (emptyQueueTrack) await st.test('the Queue scroll owner reaches the dock top without a current song [D1]', {
            todo: 'pre-existing empty grid track: .list-stage keeps "auto minmax(0, 1fr)" with a 10px gap when #queue-current is hidden',
          }, () => {
            const owner = sample.owners.find(owner => owner.el === '#playlist');
            assert.ok(owner && Math.abs(owner.underDock) <= 1, '#playlist ends exactly at the dock top: ' + JSON.stringify(owner));
          });
        }

        if (name === 'my') await st.test('My groups use 14px gutters, 12px spacing, 14px insets and corners [AGENTS §5.1, D4]', () => {
          const groups = sample.myGroups;
          assert.ok(groups.length >= 3, JSON.stringify(groups));
          // D4: one-line status cards (logged-out Bilibili login) and the Settings entry share a 44px row with
          // 14px inline insets; multi-row groups keep 14px on every side.
          const singleRow = ['#android-account-slot', '#android-open-settings'];
          for (const group of groups) {
            assert.ok(Math.abs(group.box.x - 14) <= 0.5 && Math.abs(layout.viewport[0] - group.box.r - 14) <= 0.5, `${group.el} keeps 14px page gutters`);
            assert.equal(group.radius, '14px', `${group.el} corner`);
            assert.equal(group.clipped, false, `${group.el} content is not cut off`);
            if (singleRow.includes(group.el)) {
              assert.ok(Math.abs(group.box.h - 44) <= 0.5, `${group.el} is a 44px single-row card, not ${group.box.h}px [D4]`);
              assert.deepEqual(group.inline, ['14px', '14px'], `${group.el} inline inset`);
            } else assert.equal(group.padding, '14px', `${group.el} inner inset`);
          }
          for (let i = 1; i < groups.length; i++) assert.ok(Math.abs(groups[i].box.y - groups[i - 1].box.b - 12) <= 0.5, `12px between ${groups[i - 1].el} and ${groups[i].el}`);
        });

        // D4 (decided, b3-measure.md §4): phone Settings uses the My group treatment.
        if (name === 'settings' && layout.id.startsWith('android-')) await st.test('Settings uses the My group treatment [D4]', () => {
          const groups = sample.settingsGroups;
          assert.ok(groups.length >= 2, JSON.stringify(groups));
          for (const group of groups) {
            assert.ok(Math.abs(group.box.x - 14) <= 0.5 && Math.abs(layout.viewport[0] - group.box.r - 14) <= 0.5, `${group.el} keeps 14px page gutters`);
            assert.equal(group.filled, true, `${group.el} is itself the filled card`);
            assert.equal(group.border, '1px', `${group.el} outline`);
            assert.equal(group.radius, '14px', `${group.el} corner`);
            assert.equal(group.padding, '14px', `${group.el} inner inset`);
            assert.equal(group.headingInside, true, `${group.el} heading sits inside its card`);
            assert.equal(group.clipped, false, `${group.el} content is not cut off`);
          }
          for (let i = 1; i < groups.length; i++) assert.ok(Math.abs(groups[i].box.y - groups[i - 1].box.b - 12) <= 0.5, `12px between ${groups[i - 1].el} and ${groups[i].el}`);
        });
      });
    }
  });
}

// ---------- B3 G2: portrait My/Settings own full-width scrollports ----------
// Motion clipping, resident My controls, inert ownership and My's scroll offset are covered by
// tests/mobile_host_browser.test.mjs; this checks the scrollport geometry that the native indicator follows.
for (const engine of [chromium, webkit]) for (const height of [640, 844]) {
  test(`${engine.name()} 393x${height} portrait My and Settings own full-width scrollports with 14px inner gutters [B3 G2]`, {skip: !linux, timeout: 120000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    const {page, errors} = await openSession(t, browser, {id: `android-393x${height}`, kind: 'alpha', viewport: [393, height], touch: true});
    for (const name of ['my', 'settings']) {
      await visit(page, pages[name].host);
      const value = await page.evaluate(name => {
        const owner = document.querySelector(name === 'my' ? '#android-my-scroll' : '#host-workspace-settings .settings-workspace-body');
        const box = owner.getBoundingClientRect(), style = getComputedStyle(owner);
        const groups = [...owner.children].filter(n => n.getClientRects().length && n.checkVisibility?.() !== false && n.getBoundingClientRect().height > 0)
          .map(n => { const r = n.getBoundingClientRect(); return {el: n.id || n.className, left: r.left, right: r.right}; });
        return {left: box.left, right: box.right, width: innerWidth, padding: [style.paddingLeft, style.paddingRight], groups};
      }, name);
      assert.ok(Math.abs(value.left) <= 0.5 && Math.abs(value.right - value.width) <= 0.5, `${name} owner spans the page: ` + JSON.stringify(value));
      assert.deepEqual(value.padding, ['14px', '14px'], `${name} keeps its 14px gutters inside the owner`);
      assert.ok(value.groups.length >= 2, JSON.stringify(value.groups));
      for (const group of value.groups) assert.ok(Math.abs(group.left - 14) <= 0.5 && Math.abs(value.width - group.right - 14) <= 0.5,
        `${name} ${group.el} keeps the 14px page gutters: ` + JSON.stringify(group));
    }
    assert.deepEqual(errors, []);
  });
}

// ---------- B3 G3: result viewport inset follows actual overflow, without oscillation ----------
for (const engine of [chromium, webkit]) {
  test(`${engine.name()} phone result viewports add 4px only while overflowing and settle at the threshold [B3 G3]`, {skip: !linux, timeout: 240000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    const {page, errors} = await openSession(t, browser, {id: 'android-393x844', kind: 'alpha', viewport: [393, 844], touch: true});
    let count = songs.length, query = 0;
    await page.route(/\/api\/catalog\/search(?:\?|$)/, route => {
      const url = new URL(route.request().url());
      return route.fulfill({json: {ok: true, data: {...paged(songs.slice(0, count), url), query: url.searchParams.get('q') || '', result_kind: 'songs'}}});
    });
    await visit(page, [['request', 'search'], ['click', '[data-search-mode="shared"]']]);
    const search = async total => {
      count = total;
      const text = `scroll ${++query}`;
      await visit(page, [['fill', '#shared-search-query', text], ['click', '#shared-search-button']]);
      // Empty results leave the list without cards, so wait for the committed search rather than for nodes.
      await page.waitForFunction(text => {
        const mode = state.searchModeState.shared, list = document.getElementById('shared-search-results');
        const pager = list?.closest('.android-result-frame')?.querySelector('.result-pager');
        return mode.submitted === text && !mode.loading && (!pager || pager.hidden || pager.getAttribute('aria-busy') !== 'true');
      }, text);
      await settle(page);
    };
    const inset = () => page.evaluate(() => {
      const viewport = document.getElementById('shared-search-results').closest('.result-page-viewport');
      return {inset: viewport.classList.contains('has-scroll-inset'), padding: getComputedStyle(viewport).paddingRight,
        overflow: viewport.scrollHeight - viewport.clientHeight, height: innerHeight};
    });
    const consistent = (value, label) => {
      assert.equal(value.inset, value.overflow > 1, `${label}: the inset follows actual overflow ` + JSON.stringify(value));
      assert.equal(value.padding, value.inset ? '4px' : '0px', `${label}: 4px only while scrolling ` + JSON.stringify(value));
    };
    await search(songs.length); const long = await inset(); consistent(long, 'long results');
    assert.equal(long.inset, true, 'the phone three-row page overflows at 393x844 ' + JSON.stringify(long));
    await page.locator('.android-result-frame:has(#shared-search-results) [data-page-action="next"]').click();
    await settle(page); consistent(await inset(), 'after a page turn');
    await search(2); const short = await inset(); consistent(short, 'one short row'); assert.equal(short.inset, false);
    await search(0); consistent(await inset(), 'empty results');
    await search(songs.length);
    await page.setViewportSize({width: 393, height: 1000}); await settle(page); consistent(await inset(), 'taller viewport');
    await page.setViewportSize({width: 393, height: 844}); await settle(page); consistent(await inset(), 'restored viewport');
    // Sweep the overflow threshold one CSS pixel at a time. Toggling the 4px inset narrows the cards and can
    // remove the very overflow that requested it (393x847: 5px without the inset, 1px with it), so near the
    // threshold the decision must follow the overflow measured *without* the inset. The test measures that
    // baseline independently: an inline padding override is read and restored in the same task, so no
    // frame (and no ResizeObserver delivery) ever sees it.
    const flips = [];
    for (let height = 836; height <= 872; height++) {
      await page.setViewportSize({width: 393, height}); await settle(page);
      const value = await page.evaluate(() => new Promise(resolve => {
        const viewport = document.getElementById('shared-search-results').closest('.result-page-viewport');
        let changes = 0, frames = 0;
        const observer = new MutationObserver(records => { changes += records.length; });
        observer.observe(viewport, {attributes: true, attributeFilter: ['class']});
        const tick = () => { if (++frames < 30) { requestAnimationFrame(tick); return; }
          observer.disconnect();
          const inset = viewport.classList.contains('has-scroll-inset'), padding = getComputedStyle(viewport).paddingRight;
          const overflow = viewport.scrollHeight - viewport.clientHeight;
          const previous = viewport.style.getPropertyValue('padding-right'), priority = viewport.style.getPropertyPriority('padding-right');
          viewport.style.setProperty('padding-right', '0px', 'important');
          const baseOverflow = viewport.scrollHeight - viewport.clientHeight;
          if (previous) viewport.style.setProperty('padding-right', previous, priority); else viewport.style.removeProperty('padding-right');
          resolve({changes, inset, padding, overflow, baseOverflow, restored: getComputedStyle(viewport).paddingRight === padding});
        };
        requestAnimationFrame(tick);
      }));
      flips.push({height, ...value});
      assert.equal(value.restored, true, 'the baseline measurement restores the viewport');
      assert.equal(value.changes, 0, `the inset is stable for 30 settled frames at 393x${height}: ` + JSON.stringify(value));
      assert.equal(value.inset, value.baseOverflow > 1, `393x${height}: the inset follows the overflow without the inset ` + JSON.stringify(value));
      assert.equal(value.padding, value.inset ? '4px' : '0px', `393x${height}: 4px only while scrolling ` + JSON.stringify(value));
      if (value.baseOverflow <= 0) assert.equal(value.padding, '0px', `393x${height}: a page that fits keeps no inset`);
      if (value.baseOverflow > 8) assert.equal(value.padding, '4px', `393x${height}: a clearly overflowing page keeps the inset`);
    }
    assert.ok(flips.some(v => v.baseOverflow > 8) && flips.some(v => v.baseOverflow <= 0),
      'the sweep covers fitting and clearly overflowing heights: ' + JSON.stringify(flips.map(v => [v.height, v.baseOverflow])));
    assert.ok(flips.some(v => v.inset) && flips.some(v => !v.inset), 'the sweep crosses the overflow threshold: ' + JSON.stringify(flips.map(v => [v.height, v.inset])));
    assert.deepEqual(errors, []);
  });
}

// ---------- B3 G6: announcements reserve a classic scrollbar only on overflow ----------
test('chromium desktop announcements reserve classic scrollbar width only when content overflows [B3 G6]', {skip: !linux, timeout: 120000}, async t => {
  const browser = await chromium.launch({headless: true, ignoreDefaultArgs: ['--hide-scrollbars']}); t.after(() => browser.close());
  const {page, errors} = await openSession(t, browser, {id: 'desktop-1440x900', kind: 'desktop', viewport: [1440, 900]});
  assert.equal(await page.evaluate(() => Boolean(window.BilikaraAnnouncements && state.data?.capabilities?.announcements)), true, 'the native Host offers announcements');
  let items = [];
  await page.route('**/api/announcements/check', route => route.fulfill({json: {ok: true, data: {items, automatic_ids: [], available: true}}}));
  await page.route('**/api/announcements/shown', route => route.fulfill({json: {ok: true, data: {}}}));
  const item = (id, body) => ({id, kind: 'release', title: {zh: `公告 ${id}`}, body_markdown: {zh: body}, published_at: '2026-11-01T00:00:00Z', version: '0.9.0'});
  const long = Array.from({length: 60}, (_, i) => `第 ${i + 1} 段：滚动合同的公告正文，用来产生实际的纵向溢出。`).join('\n\n');
  for (const [label, list] of [['empty', []], ['short', [item('short', '一行公告。')]], ['long', [item('long', long)]]]) {
    items = list;
    await page.evaluate(() => BilikaraAnnouncements.manual());
    await page.waitForFunction(() => !document.getElementById('announcements-modal').classList.contains('hidden')
      && document.getElementById('announcements-button').getAttribute('aria-busy') !== 'true');
    await settle(page);
    const value = await page.evaluate(() => {
      const content = document.getElementById('announcements-content'), style = getComputedStyle(content);
      return {gutter: style.scrollbarGutter, overflow: content.scrollHeight - content.clientHeight,
        classic: content.offsetWidth - content.clientWidth - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0)};
    });
    assert.equal(value.gutter, 'auto', `${label}: no stable gutter`);
    if (label === 'long') assert.ok(value.overflow > 1 && value.classic > 0, 'long content overflows and its classic scrollbar takes width: ' + JSON.stringify(value));
    else assert.ok(value.overflow <= 1 && value.classic === 0, `${label} content reserves no scrollbar width: ` + JSON.stringify(value));
    await page.evaluate(() => BilikaraAnnouncements.close());
  }
  assert.deepEqual(errors, []);
});

// ---------- D2: Remote queue dragging scrolls the document at the visible edges ----------
for (const engine of [chromium, webkit]) {
  test(`${engine.name()} Remote queue drag scrolls the document near the visible edges above the dock [D2]`, {skip: !linux, timeout: 120000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    const {page, errors} = await openSession(t, browser, {id: 'remote-393x844', kind: 'desktop', viewport: [393, 844], touch: true, remote: true});
    await visit(page, pages.queue.remote);
    const handle = page.locator('#queue-list [data-drag-handle]').first();
    await handle.scrollIntoViewIfNeeded(); await settle(page);
    const before = await page.evaluate(() => ({doc: document.scrollingElement.scrollTop, list: document.getElementById('queue-list').scrollTop,
      dockTop: document.getElementById('playback-dock').getBoundingClientRect().top}));
    const box = await handle.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, y + 12, {steps: 2});
    assert.equal(await page.evaluate(() => Boolean(state.dragItemId && state.dragMoved)), true, 'the badge drag is active');
    // Each pointer move near the edge scrolls one step; alternate by one pixel so every move is delivered.
    for (let i = 0; i < 12; i++) await page.mouse.move(x, before.dockTop - 20 - (i % 2));
    const down = await page.evaluate(() => ({doc: document.scrollingElement.scrollTop, list: document.getElementById('queue-list').scrollTop}));
    assert.ok(down.doc >= before.doc + 50, 'dragging near the visible bottom above the dock scrolls the document: ' + JSON.stringify({before, down}));
    for (let i = 0; i < 12; i++) await page.mouse.move(x, 20 + (i % 2));
    const up = await page.evaluate(() => ({doc: document.scrollingElement.scrollTop, list: document.getElementById('queue-list').scrollTop}));
    assert.ok(up.doc <= down.doc - 50, 'dragging near the visible top scrolls the document back: ' + JSON.stringify({down, up}));
    assert.deepEqual([before.list, down.list, up.list], [0, 0, 0], 'the queue list never owns scrolling');
    // Cancel instead of dropping: this checks scrolling only and must not commit a reorder.
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', {pointerId: state.dragPointerId, bubbles: true})));
    await page.mouse.up();
    assert.equal(await page.evaluate(() => state.dragItemId), '', 'the cancelled drag is cleared');
    assert.deepEqual(errors, []);
  });
}

// ---------- D4: My/Settings grouping across themes, languages and the expanded login QR ----------
for (const engine of [chromium, webkit]) {
  test(`${engine.name()} phone My/Settings groups hold across themes, languages and the expanded login QR [D4]`, {skip: !linux, timeout: 180000}, async t => {
    const browser = await engine.launch({headless: true}); t.after(() => browser.close());
    const {page, errors} = await openSession(t, browser, {id: 'android-393x844', kind: 'alpha', viewport: [393, 844], touch: true});
    const group = () => page.evaluate(() => {
      const card = document.getElementById('android-account-slot'), box = card.getBoundingClientRect(), style = getComputedStyle(card);
      const clipped = [...card.querySelectorAll('*')].filter(n => n.getClientRects().length && n.checkVisibility?.() !== false
        && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0).some(n => {
        const r = n.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5; });
      return {height: box.height, padding: style.padding, inline: [style.paddingLeft, style.paddingRight], clipped,
        overflow: card.scrollWidth > card.clientWidth + 1 || card.scrollHeight > card.clientHeight + 1};
    });
    const sections = () => page.evaluate(() => [...document.querySelectorAll('#host-workspace-settings .settings-workspace-body > .settings-section')]
      .filter(n => n.getClientRects().length).map(n => { const s = getComputedStyle(n); return {padding: s.padding, radius: s.borderRadius, border: s.borderTopWidth,
        filled: s.backgroundColor !== 'rgba(0, 0, 0, 0)', clipped: n.scrollWidth > n.clientWidth + 1}; }));
    let groupCount = null;
    for (const theme of ['light', 'dark', 'blue']) for (const language of ['zh', 'en', 'ja']) {
      await page.evaluate(([theme, language]) => { applyTheme(theme); setLanguage(language); }, [theme, language]);
      await visit(page, pages.my.host);
      const account = await group();
      assert.ok(Math.abs(account.height - 44) <= 0.5 && !account.clipped && !account.overflow, `${theme}/${language}: the collapsed login card is 44px and complete ` + JSON.stringify(account));
      assert.deepEqual(account.inline, ['14px', '14px']);
      await visit(page, pages.settings.host);
      const groups = await sections();
      // Guard against an empty loop: phone Settings shows its Appearance and Advanced groups in every theme/language.
      assert.ok(groups.length >= 2, `${theme}/${language}: Settings renders its groups ` + JSON.stringify(groups));
      groupCount ??= groups.length;
      assert.equal(groups.length, groupCount, `${theme}/${language}: the same Settings groups in every theme and language`);
      for (const section of groups) assert.deepEqual(section, {padding: '14px', radius: '14px', border: '1px', filled: true, clipped: false}, `${theme}/${language} Settings group`);
    }
    await page.evaluate(() => { applyTheme('light'); setLanguage('zh'); });
    await visit(page, pages.my.host);
    await page.evaluate(() => { fetchState = async () => {}; state.eventSource?.close();
      state.data.bbdown.login = {state: 'waiting', logged_in: false, message: '请扫码登录'}; renderBBDownLogin(state.data.bbdown.login); });
    await settle(page);
    const expanded = await group();
    assert.equal(expanded.padding, '14px', 'the expanded QR group keeps ordinary 14px padding ' + JSON.stringify(expanded));
    assert.ok(expanded.height > 44 && !expanded.clipped, 'the expanded QR content grows its group without clipping ' + JSON.stringify(expanded));
    assert.deepEqual(errors, []);
  });
}

// Remote document scrolling keeps the browser's own indicator, which CSS cannot inset above #playback-dock.
test('Remote document indicator crosses the fixed playback dock [SCROLL-R2-03 G5]', {
  skip: 'ENGINE-LIMITATION (b3-measure.md §0 F5, §4 D3): native document scroll indicators cannot be inset; Remote keeps document scrolling',
}, () => {});
