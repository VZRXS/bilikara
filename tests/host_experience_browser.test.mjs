import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { before } from 'node:test';
import { chromium, webkit } from 'playwright';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildNativeAlpha, buildNativeHost } from './native_runtime_artifacts.mjs';
import { RunningHost, isolatedEnvironment } from './native_host_support.mjs';

const require = createRequire(import.meta.url);
const ratingDialog = require('./browser/remote_rating_dialog.cjs');
let alpha, desktop;
before(async () => {
  if (process.platform !== 'linux') return;
  alpha = await buildNativeAlpha();
  desktop = await buildNativeHost();
}, { timeout: 300000 });

async function open(t, engine, role = 'host', input = {}, desktopEntry = false) {
  const home = mkdtempSync(path.join(root, '.tmp/Host experience 中文 & '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const host = await RunningHost.start(desktopEntry ? desktop : alpha, home, desktopEntry
    ? ['--data-dir', path.join(home, 'data'), '--static-dir', path.join(root, 'static')]
    : [home, path.join(root, 'static')], isolatedEnvironment(home), !desktopEntry);
  t.after(() => host.close());
  await host.api('/api/session-users/add', { name: 'Alice' });
  const browser = await engine.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ ...input, viewport: role === 'host'
    ? { width: 1920, height: 1080 } : { width: 440, height: 956 } });
  if (role === 'host') await context.addCookies([...host.cookies].map(([name, value]) => ({ name, value, url: host.base })));
  await context.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
  await context.route('**/*', route => new URL(route.request().url()).origin === host.base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.base + (role === 'remote' ? '/remote' : ''));
  await page.waitForFunction(() => typeof state !== 'undefined' && state.data?.session_user_entries?.length === 1);
  if (role === 'remote') {
    await page.waitForFunction(() => !state.remoteIdentityChecking);
    await page.evaluate(async () => applyRemoteIdentity(await apiPost('/api/remote-identity/register', { name: 'Alice', claim: true })));
    await page.locator('#remote-identity-modal').waitFor({ state: 'hidden' });
  } else if (!desktopEntry) await page.evaluate(() => { document.documentElement.dataset.hostPlatform = 'desktop'; });
  t.after(() => assert.deepEqual(errors, []));
  return { page, home, host };
}

const nativeLimit = process.platform !== 'linux'
  && 'Linux Chromium/WebKit interaction fixtures; Windows/macOS native WebViews remain separate';

test('native layout fixture publishes readable media after Host artifact recovery', {
  skip: nativeLimit, timeout: 60000,
}, async t => {
  // This checks HTTP/cache lifetime and independent bytes, not codec decoding.
  for (let index = 0; index < 3; index++) {
    const home = mkdtempSync(path.join(root, '.tmp/Layout fixture 中文 & '));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const video = Buffer.from('independent layout video bytes'), audio = Buffer.from('independent layout audio bytes');
    const videoPath = path.join(home, 'video.mp4'), audioPath = path.join(home, 'audio.m4a');
    writeFileSync(videoPath, video); writeFileSync(audioPath, audio);
    const host = await RunningHost.start(alpha, home,
      [home, path.join(root, 'static'), videoPath, audioPath],
      { ...isolatedEnvironment(home), BILIKARA_NATIVE_FIXTURE_COPY_PAUSE_MS: '350' }, true);
    t.after(() => host.close());
    const snapshot = await host.api('/api/state');
    assert.equal(snapshot.session_flags.startup_choice_pending, false, 'Offline publication finishes before resuming the real cache pump');
    assert.equal(snapshot.current_item.cache_status, 'ready');
    assert.equal(snapshot.playlist.length, 1);
    for (const item of [snapshot.current_item, ...snapshot.playlist]) {
      for (const [url, expected] of [[item.video_media_url, video], ...item.audio_variants.map(v => [v.audio_url, audio])]) {
        const response = await host.request(url);
        assert.equal(response.status, 200, response.body.toString());
        assert.deepEqual(response.body, expected, 'Startup must not retire the fixture before its first media read');
      }
    }
    await host.close();
  }
});

for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`${name} fullscreen feedback follows acknowledged operations without controls, focus theft or replay`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page, home } = await open(t, engine);
    await page.evaluate(async () => {
      fetchState = async () => {}; state.eventSource?.close(); setLanguage('zh');
      await setLocalPlayerVolumeAndMuted(.9, false);
    });
    const popup = page.locator('#presentation-feedback');
    assert.equal(await popup.isVisible(), false, 'Ordinary Host operations do not overlay the console');
    await page.evaluate(() => {
      // This exercises native-fullscreen CSS composition, not an OS window transition.
      elements.playerPanel.classList.add('is-tauri-fullscreen');
      document.body.classList.add('is-tauri-fullscreen-active'); handleFullscreenChange();
      const focus = document.createElement('button'); focus.id = 'feedback-focus-probe'; focus.textContent = 'Focus';
      focus.style.cssText = 'position:absolute;left:20px;bottom:20px;z-index:30';
      elements.playerPanel.append(focus); focus.focus();
      // An independent sibling detects accidental root replacement by the popup.
      // The idle player legitimately replaces its own empty frame on render.
      window.feedbackMedia = document.createElement('video'); elements.playerPanel.append(window.feedbackMedia);
      render();
    });
    assert.equal(await popup.isVisible(), false, 'Entering fullscreen does not replay an ordinary-window change');
    await page.evaluate(() => setLocalPlayerVolumeAndMuted(.8, false));
    await page.waitForFunction(() => document.querySelector('#presentation-feedback.is-visible .presentation-feedback-value')?.textContent === '80%');
    // WebKit can return no getAnimations() entries before its first style
    // flush. Wait for the actual endpoint rather than measuring the 3px entry
    // transform and mistaking it for the steady right inset.
    await page.waitForFunction(() => {
      const card = document.querySelector('#presentation-feedback .presentation-feedback-card.is-visible');
      if (!card) return false;
      const style = getComputedStyle(card);
      return style.opacity === '1' && new DOMMatrixReadOnly(style.transform).m41 === 0;
    }, null, { timeout: 1500 });
    const bounds = await popup.locator(".presentation-feedback-card").evaluate(node => {
      const s = getComputedStyle(node), r = node.getBoundingClientRect(), parent = node.parentElement.parentElement.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { focused: document.activeElement.id, controls: node.querySelectorAll('button,input,a,select').length,
        pointer: s.pointerEvents, blur: s.backdropFilter || s.webkitBackdropFilter, radius: s.borderRadius,
        duration: s.transitionDuration, right: parent.right - r.right,
        center: (r.top + r.bottom) / 2 - (parent.top + parent.bottom) / 2,
        within: r.left >= parent.left && r.right <= parent.right && r.top >= parent.top && r.bottom <= parent.bottom,
        intercepts: hit === node || node.contains(hit), owned: node.parentElement.parentElement === elements.playerPanel,
        media: window.feedbackMedia.isConnected };
    });
    assert.equal(bounds.focused, 'feedback-focus-probe'); assert.equal(bounds.controls, 0);
    assert.equal(bounds.pointer, 'none'); assert.equal(bounds.radius, '18px'); assert.match(bounds.blur, /blur\(/);
    assert.ok(bounds.duration.split(',').every(duration => duration.trim() === '0.12s'));
    assert.ok(Math.abs(bounds.right - 16) <= 1 && Math.abs(bounds.center) <= 1 && bounds.within, JSON.stringify(bounds));
    assert.equal(bounds.intercepts, false); assert.equal(bounds.owned, true); assert.equal(bounds.media, true);
    await page.screenshot({ path: path.join(home, `${name}-fullscreen-feedback.png`) });
    await page.evaluate(() => dispatchAvDelayAction({ type: 'adjust', delta_ms: 150 }));
    await page.waitForFunction(() => document.querySelector('#presentation-feedback [data-feedback-category=delay] .presentation-feedback-value')?.textContent === '+150ms');
    const key = await page.evaluate(() => state.presentationActionFeedback.key);
    await page.evaluate(() => dispatchAvDelayAction({ type: 'unsupported-action' }));
    assert.equal(await page.evaluate(() => state.presentationActionFeedback.key), key, 'Failed requests cannot announce success');
    await page.evaluate(async () => {
      await apiPostStateSnapshot('/api/session-users/add', { name: '用户 gypqj' }); render();
    });
    assert.equal(await popup.locator('[data-feedback-category^=user]').count(), 0);
    assert.equal(await page.evaluate(() => state.presentationActionFeedback.key), key, 'User additions stay out of playback feedback');
    await page.evaluate(async () => {
      const user = state.data.session_user_entries.find(entry => entry.name === '用户 gypqj');
      await apiPostStateSnapshot('/api/session-users/edit', { expected_version: state.data.session_users_version,
        edit: { action: 'rename', user_id: user.id, name: '改名用户' } }); render();
    });
    assert.equal(await popup.locator('[data-feedback-category^=user]').count(), 0);
    const renamed = await page.evaluate(() => state.presentationActionFeedback.key);
    await page.evaluate(async () => {
      const user = state.data.session_user_entries.find(entry => entry.name === '改名用户');
      await apiPostStateSnapshot('/api/session-users/edit', { expected_version: state.data.session_users_version,
        edit: { action: 'reorder', user_ids: [user.id], before_user_id: state.data.session_user_entries[0].id } }); render();
    });
    assert.equal(await page.evaluate(() => state.presentationActionFeedback.key), renamed, 'Sorting is not an add/remove operation');
    await page.evaluate(async () => {
      const user = state.data.session_user_entries.find(entry => entry.name === '改名用户');
      await apiPostStateSnapshot('/api/session-users/edit', { expected_version: state.data.session_users_version,
        edit: { action: 'remove', user_ids: [user.id] } }); render();
    });
    assert.equal(await popup.locator('[data-feedback-category^=user]').count(), 0);
    assert.equal(await page.evaluate(() => state.presentationActionFeedback.key), renamed, 'User edits remain Host toast operations');
    await page.waitForFunction(() => document.querySelector('#presentation-feedback').classList.contains('hidden'), null, { timeout: 4000 });
    for (const [index, theme] of ['light', 'dark', 'blue'].entries()) {
      await page.evaluate(async ({index, theme}) => {
        applyTheme(theme); await setLocalPlayerVolumeAndMuted(.6 + index * .05, false);
      }, {index, theme});
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#presentation-feedback .presentation-feedback-card')).opacity === '1');
      assert.equal(await popup.locator(".presentation-feedback-card").evaluate(node => getComputedStyle(node).backgroundColor),
        await page.evaluate(() => {
          const reference = document.createElement('div'); reference.style.backgroundColor = 'var(--modal-card-bg)';
          document.body.append(reference); const color = getComputedStyle(reference).backgroundColor; reference.remove(); return color;
        }));
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.ok((await popup.locator(".presentation-feedback-card").evaluate(node => getComputedStyle(node).transitionDuration)).split(',').every(duration => duration.trim() === '0s'));
    await page.evaluate(() => {
      elements.playerPanel.classList.remove('is-tauri-fullscreen'); document.body.classList.remove('is-tauri-fullscreen-active');
      handleFullscreenChange(); elements.playerPanel.classList.add('is-tauri-fullscreen');
      document.body.classList.add('is-tauri-fullscreen-active'); render();
    });
    await page.waitForFunction(() => document.querySelector('#presentation-feedback').classList.contains('hidden'), null, { timeout: 2000 });
    assert.equal(await page.evaluate(() => window.feedbackMedia.isConnected), true);
    assert.equal(await page.locator('#feedback-focus-probe').evaluate(node => node === document.activeElement), true);
  });

  test(`${name} desktop minimum-height layout keeps the rail and settings reachable at 700 × 600`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    const { page } = await open(t, engine, 'host', {}, true);
    await page.setViewportSize({ width: 700, height: 600 });
    await page.evaluate(() => {
      document.body.dataset.tauriPlatform = 'windows';
      elements.windowControls?.classList.remove('hidden');
    });
    const settings = page.locator('[data-host-workspace="settings"]');
    const bounds = await settings.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 700 && bounds.y + bounds.height <= 600,
      JSON.stringify(bounds));
    await settings.click();
    await page.locator('#host-workspace-settings').waitFor({ state: 'visible' });
    assert.equal(await settings.evaluate(node => node.getAttribute('aria-selected')), 'true');
    assert.equal(await page.locator('[data-android-orientation-mode]').count(), 0,
      'Desktop settings must not contain a manual screen-direction selector');
    assert.equal(await page.evaluate(() => Boolean(window.BilikaraHostLayout)), false,
      'A real desktop entry must not initialize Android phone navigation');
    assert.equal(await page.locator('.player-panel').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });

  for (const role of ['host', 'remote']) test(`${name} ${role} long titles loop left while small overflow returns without duplicating accessible text`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page } = await open(t, engine, role);
    if (role === 'host') await page.setViewportSize({ width: 700, height: 1080 });
    await page.evaluate(role => {
      fetchState = async () => {}; state.eventSource?.close();
      if (role === 'remote') {
        state.data.current_item = { id: 'marquee-song', play_id: 'marquee-song', bvid: 'BV1xx411c7mD',
          display_title: '初始歌曲', requester_name: 'Alice', cache_status: 'pending', duration_seconds: 120 };
        render();
      }
      const container = role === 'host' ? elements.currentTitle : elements.playbackDockTitle;
      const track = role === 'host' ? elements.currentTitleText : elements.playbackDockTitleText;
      container.style.width = '220px'; container.style.maxWidth = '220px';
      const measure = role === 'host' ? measurePersistentStage : syncPlaybackDockMarquees;
      BilikaraTextMarquee.reset(container, track);
      track.textContent = '小'; measure();
      for (let length = 2; length < 100; length++) {
        track.textContent = '小'.repeat(length); measure();
        if (track.scrollWidth > container.clientWidth * 1.2) break;
      }
    }, role);
    const selector = role === 'host' ? '#current-title' : '#playback-dock-title';
    const small = await page.locator(selector).evaluate(node => {
      const track = node.firstElementChild, s = getComputedStyle(track);
      return { available: node.clientWidth, natural: track.scrollWidth,
        animation: s.animationName, loop: node.classList.contains('is-text-marquee-loop'), copies: node.querySelectorAll('.text-marquee-copy').length };
    });
    assert.ok(small.natural > small.available && small.natural < small.available * 2, JSON.stringify(small));
    assert.equal(small.loop, false); assert.equal(small.copies, 0);
    assert.equal(small.animation, role === 'host' ? 'host-current-title-marquee' : 'playback-dock-marquee');
    const long = '长标题 gypqj '.repeat(60);
    await page.evaluate(({role, long}) => {
      const track = role === 'host' ? elements.currentTitleText : elements.playbackDockTitleText;
      track.textContent = long;
      (role === 'host' ? measurePersistentStage : syncPlaybackDockMarquees)();
    }, {role, long});
    const evidence = await page.locator(selector).evaluate(async node => {
      const track = node.firstElementChild, copy = node.querySelector('.text-marquee-copy');
      const animation = track.getAnimations().find(a => a.animationName === 'text-marquee-loop');
      if (!animation) return { animation: getComputedStyle(track).animationName };
      animation.pause();
      const duration = animation.effect.getTiming().duration;
      const x = [];
      for (const fraction of [0, .25, .5, .75, .999]) {
        animation.currentTime = duration * fraction;
        x.push(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41);
      }
      animation.currentTime = duration;
      const end = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      const before = track.getAnimations()[0];
      (node.id === 'current-title' ? measurePersistentStage : syncPlaybackDockMarquees)();
      return { animation: getComputedStyle(track).animationName, x, end, text: track.textContent,
        copy: copy?.textContent, hidden: copy?.getAttribute('aria-hidden'), copies: node.querySelectorAll('.text-marquee-copy').length,
        sameAnimation: track.getAnimations()[0] === before };
    });
    assert.equal(evidence.animation, 'text-marquee-loop');
    assert.equal(evidence.text, long); assert.equal(evidence.copy, long);
    assert.equal(evidence.hidden, 'true'); assert.equal(evidence.copies, 1);
    assert.ok(evidence.x.every((x, index) => !index || x < evidence.x[index - 1]), JSON.stringify(evidence.x));
    assert.ok(Math.abs(evidence.end) <= 1, 'The identical next copy joins the next cycle at the original origin');
    assert.equal(evidence.sameAnimation, true, 'Unchanged measurements do not restart the loop');
    const accessible = await page.locator(selector).ariaSnapshot();
    assert.equal(accessible.split(long.trim()).length - 1, 1, 'Screen readers receive only the canonical title');
    if (role === 'remote') {
      await page.evaluate(long => { state.data.current_item.display_title = long; render(); openPlaybackSheet(); }, long);
      const field = page.locator('[data-playback-metadata-field="title"]');
      await page.waitForFunction(() => document.querySelector('[data-playback-metadata-field="title"]').classList.contains('is-text-marquee-loop'));
      assert.equal(await field.evaluate(node => getComputedStyle(node.firstElementChild).animationName), 'text-marquee-loop');
      assert.equal(await field.evaluate(node => node.querySelectorAll('.text-marquee-copy').length), 1);
      await page.evaluate(() => closePlaybackSheet());
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node.firstElementChild).animationName), 'none');
    await page.evaluate(role => {
      (role === 'host' ? elements.currentTitleText : elements.playbackDockTitleText).textContent = '短标题';
      (role === 'host' ? measurePersistentStage : syncPlaybackDockMarquees)();
    }, role);
    assert.equal(await page.locator(selector).evaluate(node => node.querySelectorAll('.text-marquee-copy').length), 0);
  });

  test(`${name} shared request titles loop only their overflowing remainder and pause outside the viewport`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page } = await open(t, engine);
    const title = '共享卡片长标题 gypqj '.repeat(50);
    await page.evaluate(title => {
      const node = document.createElement('div');
      node.id = 'marquee-card-fixture'; node.className = 'follow-up-name';
      node.style.cssText = 'position:fixed;left:20px;top:20px;width:200px';
      node.textContent = title; document.body.append(node);
    }, title);
    const card = page.locator('#marquee-card-fixture');
    await page.waitForFunction(() => document.querySelector('#marquee-card-fixture .text-marquee-copy')
      && document.querySelector('#marquee-card-fixture').classList.contains('is-card-title-visible'));
    const result = await card.evaluate(node => {
      const [first, remainder] = node.children, track = remainder.firstElementChild;
      return { text: first.textContent + track.textContent, copies: remainder.querySelectorAll('.text-marquee-copy').length,
        loop: getComputedStyle(track).animationName, state: getComputedStyle(track).animationPlayState };
    });
    assert.deepEqual(result, { text: title, copies: 1, loop: 'text-marquee-loop', state: 'running' });
    const remainderText = await card.locator('.request-card-title-track').first().textContent();
    assert.equal((await card.ariaSnapshot()).split(remainderText.trim()).length - 1, 1, 'Only one second-line text is announced');
    await card.evaluate(node => { node.style.top = '-5000px'; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#marquee-card-fixture .request-card-title-track')).animationPlayState === 'paused');
    await card.evaluate(node => { node.style.top = '20px'; node.textContent = '短标题'; });
    await page.waitForFunction(() => document.querySelector('#marquee-card-fixture .request-card-title-track')?.textContent === '');
    assert.equal(await card.textContent(), '短标题');
    assert.equal(await card.locator('.text-marquee-copy').count(), 0);
  });

  test(`${name} Host trash help stays accessible when disabled and uses shared animated top-layer help`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page } = await open(t, engine);
    await page.evaluate(() => { fetchState = async () => {}; state.eventSource?.close(); setLanguage('zh'); activateHostWorkspace('users', { inputOrigin: 'programmatic' }); });
    const slot = page.locator('.session-user-trash-slot'), bubble = page.locator('#session-user-trash-help');
    assert.equal(await page.locator('#session-user-trash').isDisabled(), true);
    await slot.focus();
    await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    const help = await bubble.evaluate(node => {
      const s = getComputedStyle(node), r = node.getBoundingClientRect();
      return { text: node.textContent, topLayer: node.matches(':popover-open'), opacity: s.opacity,
        font: s.fontSize, radius: s.borderRadius, within: r.left >= 8 && r.right <= innerWidth - 8,
        painted: node.contains(document.elementFromPoint(r.left + 10, r.top + 10)) };
    });
    assert.match(help.text, /拖.*删除/); assert.ok(help.topLayer && help.within && help.painted);
    assert.equal(help.opacity, '1'); assert.equal(help.font, '13px'); assert.equal(help.radius, '12px');
    await page.keyboard.press('Escape');
    await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    assert.equal(await bubble.evaluate(node => node.matches(':popover-open')), false);
    assert.equal(await page.evaluate(() => state.sessionUserEditor.drag), null);
  });

  test(`${name} Host workspace exit preserves panel and child geometry through rapid tab switches`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page } = await open(t, engine);
    await page.evaluate(() => { fetchState = async () => {}; state.eventSource?.close(); });
    for (const width of [1920, 700]) {
      await page.setViewportSize({ width, height: 1080 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      for (const from of ['users', 'settings', 'request', 'queue', 'history', 'random']) {
        await page.evaluate(from => activateHostWorkspace(from, { inputOrigin: 'programmatic' }), from);
        await page.waitForFunction(from => {
          const panel = [...elements.hostWorkspacePanels].find(node => node.dataset.hostWorkspacePanel === from);
          return panel.getBoundingClientRect().width > 0 && !state.hostWorkspaceTransition;
        }, from);
        const evidence = await page.evaluate(from => {
          const panel = [...elements.hostWorkspacePanels].find(node => node.dataset.hostWorkspacePanel === from);
          const geometry = () => [panel, ...panel.children].map(node => {
            const r = node.getBoundingClientRect();
            return { width: r.width, height: r.height, display: getComputedStyle(node).display };
          });
          const before = geometry();
          activateHostWorkspace(from === 'users' ? 'queue' : 'users', { inputOrigin: 'pointer' });
          return { before, after: geometry() };
        }, from);
        for (const [i, before] of evidence.before.entries()) {
          const after = evidence.after[i];
          assert.equal(after.display, before.display, `${width}px ${from} child ${i} display`);
          assert.ok(Math.abs(after.width - before.width) <= 1 && Math.abs(after.height - before.height) <= 1,
            `${width}px ${from} child ${i}: ${JSON.stringify({before, after})}`);
        }
        await page.evaluate(from => activateHostWorkspace(from, { inputOrigin: 'pointer' }), from);
        await page.waitForFunction(() => !state.hostWorkspaceTransition);
        assert.equal(await page.evaluate(() => document.querySelectorAll('.is-tool-transition-out').length), 0);
      }
    }
  });

  test(`${name} Host user selection and drag previews retain shape and visible first insertion marks`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page, host } = await open(t, engine);
    await host.api('/api/session-users/add', { name: '第二位 用户' });
    await page.waitForFunction(() => state.sessionUserEditor.entries.length === 2);
    await page.evaluate(() => { fetchState = async () => {}; state.eventSource?.close(); activateHostWorkspace('users'); });
    for (const mode of ['', 'select']) {
      const result = await page.evaluate(mode => {
        const editor = state.sessionUserEditor; editor.setMode(mode);
        const [first, second] = editor.list.querySelectorAll('.session-user-badge');
        if (mode) { editor.selected.add(first.dataset.userId); editor.sync(); }
        const inset = first.getBoundingClientRect().left - editor.list.getBoundingClientRect().left;
        if (mode) { editor.selected.clear(); editor.sync(); }
        let image;
        const dataTransfer = { setData() {}, setDragImage(node) { image = node; } };
        editor.dragStart({ target: second, dataTransfer });
        const appearance = node => {
          const box = node.getBoundingClientRect(), style = getComputedStyle(node);
          const number = getComputedStyle(node.querySelector('.session-user-order-number'));
          return { width: box.width, height: box.height, radius: style.borderRadius,
            padding: style.padding, numberBackground: number.backgroundColor, numberMargin: number.marginLeft };
        };
        const source = appearance(second), preview = appearance(image.firstElementChild);
        const box = first.getBoundingClientRect(); editor.chooseDrop(box.left, box.top + box.height / 2);
        const mark = getComputedStyle(first, '::before');
        const visibleMarker = first.classList.contains('drop-before') && mark.content !== 'none'
          && inset + Number.parseFloat(mark.left) >= 0;
        editor.finishDrag();
        return { inset, source, preview, visibleMarker, copies: document.querySelectorAll('.session-user-drag-image').length };
      }, mode);
      assert.ok(result.inset >= 7, `${mode || 'normal'} reserves outline and insertion-marker space`);
      assert.deepEqual(result.preview, result.source, `${mode || 'normal'} drag image matches the source tag`);
      assert.equal(result.visibleMarker, true);
      assert.equal(result.copies, 0);
    }
    for (const mode of ['', 'select']) {
      await page.evaluate(mode => state.sessionUserEditor.setMode(mode), mode);
      const source = page.locator('#session-user-list .session-user-badge').nth(1);
      const first = page.locator('#session-user-list .session-user-badge').first();
      const sourceId = await source.getAttribute('data-user-id');
      await page.evaluate(() => {
        globalThis.firstMarkerPainted = false;
        if (globalThis.observeFirstMarker) document.removeEventListener('dragover', observeFirstMarker);
        globalThis.observeFirstMarker = () => {
          const node = document.querySelector('#session-user-list .session-user-badge');
          if (!node.classList.contains('drop-before')) return;
          const box = node.getBoundingClientRect(), marker = getComputedStyle(node, '::before');
          const x = box.left + Number.parseFloat(marker.left) + 2, y = box.top + box.height / 2;
          firstMarkerPainted ||= node.contains(document.elementFromPoint(x, y));
        };
        document.addEventListener('dragover', observeFirstMarker);
      });
      await source.dragTo(first, { sourcePosition: { x: 5, y: 18 }, targetPosition: { x: 2, y: 18 } });
      assert.equal(await page.evaluate(() => firstMarkerPainted), true, `${mode || 'normal'} first marker is actually painted during HTML dragging`);
      await page.waitForFunction(id => state.sessionUserEditor.entries[0].id === id && !state.sessionUserEditor.busy, sourceId);
      assert.equal((await host.api('/api/state')).session_user_entries[0].id, sourceId, 'Actual HTML drop reaches the native atomic reorder');
    }
  });

  test(`${name} touch Host keeps user outlines and first insertion marks inside the scroll track in every editing mode`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page, host } = await open(t, engine, 'host', { hasTouch: true, isMobile: true });
    await host.api('/api/session-users/add', { name: '第二位 用户' });
    await page.waitForFunction(() => state.sessionUserEditor.entries.length === 2);
    await page.setViewportSize({ width: 700, height: 1080 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => { fetchState = async () => {}; state.eventSource?.close(); activateHostWorkspace('users', { inputOrigin: 'programmatic' }); });
    await page.waitForFunction(() => document.querySelector('#session-user-list .session-user-badge').getBoundingClientRect().height > 0);
    for (const mode of ['', 'rename', 'select']) {
      const result = await page.evaluate(mode => {
        const editor = state.sessionUserEditor; editor.setMode(mode);
        const [first, second] = editor.list.querySelectorAll('.session-user-badge');
        if (mode === 'select') { editor.selected.add(second.dataset.userId); editor.sync(); }
        const rect = first.getBoundingClientRect(), bounds = editor.list.getBoundingClientRect();
        let prevent = false;
        if (mode === 'rename') editor.dragStart({target: second, preventDefault() { prevent = true; }});
        else { editor.beginDrag(second); editor.chooseDrop(rect.left, rect.top + rect.height / 2); }
        const after = first.getBoundingClientRect(), marker = getComputedStyle(first, '::before');
        const result = { coarse: editor.coarse, height: rect.height, inset: rect.left - bounds.left,
          same: rect.width === after.width && rect.height === after.height,
          marked: first.classList.contains('drop-before') && rect.left + Number.parseFloat(marker.left) >= bounds.left,
          renameRejected: prevent, drag: Boolean(editor.drag) };
        editor.finishDrag(); return result;
      }, mode);
      assert.equal(result.coarse, true); assert.equal(result.height, 44);
      assert.ok(result.inset >= 7 && result.same, JSON.stringify(result));
      if (mode === 'rename') assert.ok(result.renameRejected && !result.drag, 'Rename retains its deliberate exclusion of reordering');
      else assert.equal(result.marked, true);
    }
  });

  test(`${name} Host info-bubble placement excludes its entry transform`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page } = await open(t, engine);
    await page.evaluate(() => {
      fetchState = async () => {}; state.eventSource?.close();
      activateHostWorkspace('settings');
    });
    const button = page.locator('button[aria-describedby="host-av-sync-info"]');
    const bubble = page.locator('#host-av-sync-info');
    await button.click();
    await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    const gap = await button.evaluate(node => {
      const anchor = node.getBoundingClientRect();
      const tip = document.getElementById(node.getAttribute('aria-describedby')).getBoundingClientRect();
      return anchor.top - tip.bottom;
    });
    assert.ok(Math.abs(gap - 7) <= 1, `Settled gap must remain 7px, observed ${gap}`);
    await page.evaluate(() => { closeCacheAdvancedInfo(); });
    await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    assert.equal(await bubble.evaluate(node => node.matches(':popover-open')), false);
    await bubble.evaluate(node => { node.removeAttribute('popover'); node.showPopover = undefined; });
    await button.click();
    await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    assert.ok(await button.evaluate(node => {
      const anchor = node.getBoundingClientRect(), tip = document.getElementById(node.getAttribute('aria-describedby')).getBoundingClientRect();
      return Math.abs(anchor.top - tip.bottom - 7) <= 1;
    }), 'The existing no-Popover path also excludes its own motion transform');
  });

  test(`${name} Remote full-text bubble retains top-layer geometry and exit motion on rapid reopen`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page } = await open(t, engine, 'remote');
    await page.evaluate(() => {
      fetchState = async () => {}; state.eventSource?.close();
      state.data.current_item = { id: 'bubble-song', play_id: 'bubble-song', bvid: 'BV1xx411c7mD',
        display_title: '完整标题 gypqj '.repeat(35), requester_name: 'Alice',
        owner_name: '完整上传者 '.repeat(35), cache_status: 'ready', duration_seconds: 120 };
      render(); openPlaybackSheet();
    });
    const anchor = page.locator('[data-playback-metadata-field="title"]');
    await page.waitForFunction(() => document.querySelector('[data-playback-metadata-field="title"]').classList.contains('is-disclosable'));
    await anchor.click();
    const bubble = page.locator('#playback-metadata-popover');
    await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    assert.equal(await bubble.evaluate(node => node.matches(':popover-open')), true, 'Text annotations use the same top layer as info bubbles');
    const geometry = await bubble.evaluate(node => {
      const rect = node.getBoundingClientRect(), text = node.querySelector('p');
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height, scrolls: text.scrollHeight > text.clientHeight,
        overflow: getComputedStyle(node).overflow, scrollOverflow: getComputedStyle(text).overflow };
    });
    assert.ok(geometry.left >= 8 && geometry.right <= 432 && geometry.top >= 8 && geometry.bottom <= 948);
    assert.ok(geometry.width <= 320 && geometry.height <= 224);
    assert.equal(geometry.overflow, 'visible', 'The shared speech-bubble arrow stays outside the scroll region');
    assert.equal(geometry.scrollOverflow, 'auto');
    assert.equal(geometry.scrolls, true, 'Full text remains available through bounded scrolling');
    const closing = await page.evaluate(() => {
      const tip = elements.playbackMetadataPopover, anchor = state.playbackMetadataPopoverAnchor;
      const position = [tip.style.left, tip.style.top];
      closePlaybackMetadataPopover();
      return { hidden: tip.hidden, topLayer: tip.matches(':popover-open'),
        positionKept: position[0] === tip.style.left && position[1] === tip.style.top,
        anchorKept: state.playbackMetadataPopoverAnchor === anchor,
        durations: tip.getAnimations().map(animation => animation.effect.getTiming().duration) };
    });
    assert.equal(closing.hidden, false, 'Exit must remain painted');
    assert.equal(closing.topLayer, true);
    assert.equal(closing.positionKept, true);
    assert.equal(closing.anchorKept, true);
    assert.ok(closing.durations.includes(120));
    await anchor.click();
    await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    assert.equal(await bubble.evaluate(node => !node.hidden && node.matches(':popover-open')), true, 'A stale close must not hide the reopened node');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => elements.playbackMetadataPopover.hidden);
    assert.equal(await bubble.evaluate(node => node.matches(':popover-open')), false);
    assert.equal(await anchor.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => state.playbackSheetOpen), true, 'First Escape closes only the annotation');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await anchor.click();
    assert.ok(await bubble.evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(duration => Number.parseFloat(duration) <= 0.001)));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => elements.playbackMetadataPopover.hidden);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await bubble.evaluate(node => { node.removeAttribute('popover'); node.showPopover = undefined; node.hidePopover = undefined; });
    await anchor.click();
    await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    const fallback = await bubble.boundingBox();
    assert.ok(fallback && fallback.x >= 8 && fallback.y >= 8 && fallback.x + fallback.width <= 432 && fallback.y + fallback.height <= 948);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => elements.playbackMetadataPopover.hidden);
  });

  for (const role of ['host', 'remote']) test(`${name} ${role} help bubbles keep shared geometry, motion, layering and rapid-reopen ownership`, {
    skip: nativeLimit, timeout: 120000,
  }, async t => {
    const { page } = await open(t, engine, role, role === 'remote' ? { hasTouch: true, isMobile: true } : {});
    await page.evaluate(role => {
      fetchState = async () => {}; state.eventSource?.close();
      if (role === 'host') setRemoteQrPinned(true);
      else { setRemoteMenuOpen(true); setRemoteSettingsSectionOpen(true); }
    }, role);
    const id = role === 'host' ? 'internet-remote-mode-description' : 'remote-menu-language-info';
    const bubble = page.locator(`#${id}`), button = page.locator(`button[aria-describedby="${id}"]`);
    for (const theme of ['light', 'dark', 'blue']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      await button.click();
      await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
      const style = await bubble.evaluate(node => {
        const s = getComputedStyle(node), r = node.getBoundingClientRect();
        return { font: s.fontSize, weight: s.fontWeight, line: s.lineHeight, radius: s.borderRadius,
          padding: s.padding, transform: s.transform, painted: node.contains(document.elementFromPoint(r.x + 10, r.y + 10)),
          layer: node.matches(':popover-open'), width: r.width };
      });
      assert.deepEqual({font: style.font, weight: style.weight, line: style.line, radius: style.radius, padding: style.padding},
        {font: '13px', weight: '400', line: '18.85px', radius: '12px', padding: '10px 14px'}, theme);
      assert.equal(style.transform, 'matrix(1, 0, 0, 1, 0, 0)');
      assert.ok(style.layer && style.painted && style.width <= 320);
      const exit = await button.evaluate(node => {
        node.click(); const tip = document.getElementById(node.getAttribute('aria-describedby'));
        return { layer: tip.matches(':popover-open'), left: tip.style.left,
          animations: tip.getAnimations().map(animation => ({ duration: animation.effect.getTiming().duration,
            frames: animation.effect.getKeyframes().map(frame => frame.transform).filter(Boolean) })) };
      });
      assert.ok(exit.layer && exit.left);
      assert.ok(exit.animations.some(animation => animation.duration === 120 && animation.frames.some(frame => frame.includes('3px'))));
      await button.evaluate(node => node.click());
      await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
      assert.equal(await bubble.evaluate(node => node.matches(':popover-open')), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(id => !document.getElementById(id).matches(':popover-open'), id);
    }
    if (role === 'remote') {
      await button.hover();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await bubble.evaluate(node => node.matches(':popover-open')), false, 'Remote hover alone never opens help');
    }
    for (const [width, height] of role === 'host' ? [[700, 500], [1920, 1080]] : [[320, 480], [440, 956], [844, 390]]) {
      await page.setViewportSize({ width, height });
      for (const language of ['zh', 'en', 'ja']) {
        await page.evaluate(language => setLanguage(language), language);
        await button.click();
        await bubble.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
        const bounds = await bubble.boundingBox();
        assert.ok(bounds.x >= 7 && bounds.y >= 7 && bounds.x + bounds.width <= width - 7
          && bounds.y + bounds.height <= height - 7, `${role} ${language} ${width}x${height}: ${JSON.stringify(bounds)}`);
        await page.keyboard.press('Escape');
        await page.waitForFunction(id => !document.getElementById(id).matches(':popover-open'), id);
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await button.evaluate(node => node.blur());
    await button.focus();
    await bubble.waitFor({state:'visible'});
    assert.ok(await bubble.evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(duration => Number.parseFloat(duration) <= 0.001)));
    await page.keyboard.press('Escape');
    await page.waitForFunction(id => !document.getElementById(id).matches(':popover-open'), id);
  });

  for (const fallback of [false, true]) test(`${name} Remote first tap animates every help bubble${fallback ? ' without Popover' : ''}`, {
    skip: nativeLimit, timeout: 120000,
  }, async t => {
    const { page } = await open(t, engine, 'remote', { hasTouch: true, isMobile: true });
    page.setDefaultTimeout(5000);
    await page.evaluate(fallback => {
      fetchState = async () => {}; state.eventSource?.close();
      if (fallback) document.querySelectorAll('.remote-tooltip-bubble').forEach(tip => {
        tip.removeAttribute('popover'); tip.showPopover = undefined; tip.hidePopover = undefined;
      });
      window.helpEntryFrames = [];
      window.captureHelpEntry = true;
      // Observe the real tap after the application's handler, in the same frame.
      // Pausing actual CSS transitions makes the mid-animation paint deterministic.
      document.addEventListener('click', event => {
        const button = event.target.closest('.remote-info-button');
        if (!button || !window.captureHelpEntry) return;
        const tip = document.getElementById(button.getAttribute('aria-describedby'));
        const animations = tip.getAnimations();
        const frames = animations.map(animation => ({ duration: animation.effect.getTiming().duration,
          frames: animation.effect.getKeyframes().map(frame => ({ opacity: frame.opacity, transform: frame.transform })) }));
        for (const animation of animations) { animation.pause(); animation.currentTime = 60; }
        const style = getComputedStyle(tip);
        window.helpEntryFrames.push({ id: tip.id, frames, opacity: Number(style.opacity),
          y: new DOMMatrixReadOnly(style.transform).m42, layer: tip.matches(':popover-open'),
          pinned: button.closest('.info-trigger-wrap').classList.contains('is-pinned') });
      });
      setRemoteMenuOpen(true); setRemoteSettingsSectionOpen(true);
    }, fallback);
    async function entry(button) {
      if (fallback) await button.evaluate(node => {
        // Queue help is cloned after page load, so disable its API as well.
        const tip = node.closest('.info-trigger-wrap').querySelector('.remote-tooltip-bubble')
          || document.getElementById(node.getAttribute('aria-describedby'));
        tip.removeAttribute('popover'); tip.showPopover = undefined; tip.hidePopover = undefined;
      });
      const count = await page.evaluate(() => window.helpEntryFrames.length);
      await button.tap();
      const result = await page.evaluate(() => window.helpEntryFrames.at(-1));
      assert.equal(await page.evaluate(() => window.helpEntryFrames.length), count + 1,
        `Each tap opens its own bubble: ${await button.getAttribute('aria-describedby')}`);
      assert.ok(result.pinned, `${result.id}: touch pins the help`);
      assert.equal(result.layer, !fallback);
      assert.ok(result.frames.some(animation => animation.duration === 120
        && animation.frames[0].opacity === '0' && animation.frames.at(-1).opacity === '1'),
      `${result.id}: first tap must fade in, ${JSON.stringify(result)}`);
      assert.ok(result.frames.some(animation => animation.duration === 120
        && animation.frames[0].transform === 'translateY(3px)' && animation.frames.at(-1).transform === 'translateY(0px)'),
      `${result.id}: first tap must slide 3px, ${JSON.stringify(result)}`);
      assert.ok(result.opacity > 0 && result.opacity < 1 && result.y > 0 && result.y < 3,
        `${result.id}: the actual middle frame must be partially painted and displaced`);
      await page.evaluate(() => {
        for (const tip of document.querySelectorAll('.remote-tooltip-bubble.is-visible')) {
          tip.getAnimations().forEach(animation => animation.finish());
        }
      });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.remote-tooltip-bubble.is-visible, .remote-tooltip-bubble.is-closing'));
    }
    for (const id of ['remote-connection-status-text', 'remote-menu-language-info', 'remote-menu-theme-info']) {
      await entry(page.locator(`button[aria-describedby="${id}"]`));
    }
    await page.evaluate(() => {
      setRemoteMenuOpen(false);
      state.data.current_item = { id: 'help-song', play_id: 'help-song', display_title: '歌曲', requester_name: 'Alice', cache_status: 'ready' };
      render(); openPlaybackSheet();
    });
    for (const id of ['remote-av-sync-info', 'remote-volume-info', 'remote-key-shift-info']) {
      await entry(page.locator(`button[aria-describedby="${id}"]`));
    }
    await page.evaluate(() => { closePlaybackSheet({ immediate: true }); openHistoryExportDialog(); });
    for (const id of ['history-export-source-info', 'history-export-page-info']) {
      await entry(page.locator(`button[aria-describedby="${id}"]`));
    }
    await page.evaluate(() => { closeHistoryExportDialog(); openBindingSheet({}, { pages: [{ page: 1, part: '示例', duration: 120 }] }); });
    await entry(page.locator('button[aria-describedby="binding-sheet-help"]'));
    await page.evaluate(() => closeBindingSheet());
    await page.locator('#binding-sheet').waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      state.data.playlist = [{ id: 'queue-help', display_title: '队列歌曲', requester_name: 'Alice', cache_status: 'pending' }];
      renderQueue(state.data.playlist);
    });
    await entry(page.locator('.queue-drag-handle').first());
    assert.equal(await page.evaluate(() => window.helpEntryFrames.length), 10);
    if (fallback) return;
    await page.evaluate(() => {
      window.captureHelpEntry = false;
      state.data.queue_version = 'queue-help-version';
      state.data.playlist.push({ id: 'queue-help-2', display_title: '第二首', requester_name: 'Alice', cache_status: 'pending' });
      renderQueue(state.data.playlist);
      window.helpQueueNode = elements.queueList.firstElementChild;
    });
    const handle = page.locator('.queue-drag-handle').first();
    const origin = await handle.boundingBox();
    const x = origin.x + origin.width / 2, y = origin.y + origin.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 3, y + 1); await page.mouse.up();
    assert.equal(await handle.getAttribute('aria-expanded'), 'true', 'Sub-6px jitter still opens help');
    assert.equal(await page.evaluate(() => state.reorderConfirmSheetOpen), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.remote-tooltip-bubble.is-closing'));
    const dragOrigin = await handle.boundingBox();
    const dragX = dragOrigin.x + dragOrigin.width / 2, dragY = dragOrigin.y + dragOrigin.height / 2;
    const target = await page.locator('.queue-item').nth(1).boundingBox();
    await page.mouse.move(dragX, dragY); await page.mouse.down();
    assert.equal(await page.evaluate(() => state.dragItemId), 'queue-help');
    // Stay inside the visible row, rather than crossing its clipped bottom edge.
    await page.mouse.move(dragX, target.y + target.height * 0.6);
    assert.deepEqual(await page.evaluate(() => ({ moved: state.dragMoved, target: state.dragTargetId,
      after: state.dragTargetAfter })), { moved: true, target: 'queue-help-2', after: true });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => state.reorderConfirmSheetOpen), true);
    assert.deepEqual(await page.evaluate(() => state.reorderConfirmIntent), {
      itemId: 'queue-help', targetIndex: 1, queueVersion: 'queue-help-version', title: '队列歌曲',
    });
    assert.equal(await handle.getAttribute('aria-expanded'), 'false', 'Dragging must suppress the following help click');
    await page.evaluate(() => closeReorderConfirmSheet());
    await page.locator('#reorder-confirm-sheet').waitFor({ state: 'hidden' });
    const cancelOrigin = await handle.boundingBox();
    const cancelX = cancelOrigin.x + cancelOrigin.width / 2, cancelY = cancelOrigin.y + cancelOrigin.height / 2;
    await page.mouse.move(cancelX, cancelY); await page.mouse.down();
    await page.mouse.move(cancelX, cancelY + 7);
    await handle.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => ({ dragging: state.dragItemId, confirmation: state.reorderConfirmSheetOpen,
      ids: state.data.playlist.map(item => item.id), nodePreserved: elements.queueList.firstElementChild === window.helpQueueNode })),
    { dragging: '', confirmation: false, ids: ['queue-help', 'queue-help-2'], nodePreserved: true });
  });

  for (const role of ['host', 'remote']) test(`${name} ${role} ratings save editable waiting values and lock only actual submission`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page, home } = await open(t, engine, role);
    await ratingDialog(page, { bvid: 'BV1xx411c7mD', title: 'Rating fixture', owner_mid: 42 }, home, { role });
  });

  test(`${name} desktop rail hover matches selection and random covers ignore title/artwork size`, {
    skip: nativeLimit, timeout: 90000,
  }, async t => {
    const { page } = await open(t, engine);
    const rail = page.locator('#work-rail-random');
    for (const theme of ['light', 'dark', 'blue']) {
      await page.evaluate(theme => { applyTheme(theme); activateHostWorkspace('queue', { inputOrigin: 'programmatic' }); }, theme);
      await rail.hover();
      await rail.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
      const hover = await rail.evaluate(node => getComputedStyle(node).color);
      await rail.click();
      await rail.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
      assert.equal(await rail.evaluate(node => getComputedStyle(node).color), hover, theme);
    }
    await page.route('**/fixture-cover', route => route.fulfill({ contentType: 'image/svg+xml', body:
      '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="500"><rect width="90" height="500" fill="orange"/></svg>' }));
    for (const width of [700, 1280, 1920]) {
      await page.setViewportSize({ width, height: 1080 });
      const covers = [];
      for (const [title, artwork] of [['短标题', false], ['Long title 中文'.repeat(25), true]]) {
        await page.evaluate(({ title, artwork }) => {
          state.gatchaCandidate = { bvid: 'BV1xx411c7mD', title, owner_name: 'Artist', cover_url: artwork ? location.origin + '/fixture-cover' : '' };
          state.gatchaView = 'candidate'; renderGatchaWorkspace();
        }, { title, artwork });
        if (artwork) await page.locator('#gatcha-candidate-card img').evaluate(image => image.decode());
        await page.evaluate(() => Promise.allSettled(document.getAnimations()
          .filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)));
        covers.push(await page.locator('#gatcha-candidate-card .search-result-cover').evaluate(node => {
          const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height };
        }));
      }
      assert.deepEqual(covers[0], covers[1], 'Image dimensions and title must not resize the cover');
      assert.ok(Math.abs(covers[0].width / covers[0].height - 16 / 9) < 0.01);
      const size = await page.locator('#gatcha-candidate-card').evaluate(node => {
        const parent = node.parentElement, style = getComputedStyle(parent);
        return { actual: node.getBoundingClientRect().width,
          available: parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
      assert.ok(Math.abs(size.actual - Math.min(360, size.available)) < 1, JSON.stringify(size));
    }
  });

  test(`${name} Remote progress remains keyboard/touch usable and cancels interrupted scrubbing`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    const { page } = await open(t, engine, 'remote');
    await page.evaluate(() => {
      fetchState = async () => {}; state.eventSource?.close();
      state.ratingOptOut = true;
      const current = { id: 'seek-fixture', bvid: 'BV1xx411c7mD', title: 'Seek fixture', cache_status: 'ready', selected_pages: [1], selected_durations: [120],
        video_media_url: location.origin + '/fixture.mp4', audio_variants: [{ audio_url: location.origin + '/fixture.m4a' }] };
      state.data.current_item = current;
      state.data.playback_generation = 1;
      state.data.player_status = { item_id: current.id, playback_generation: 1, current_time: 20, duration: 120, is_paused: true };
      renderCurrentItem(current); openPlaybackSheet();
      renderCurrentPlaybackState(current);
      renderPlayerControls(current, 'local');
      paintPlaybackClockSurfaces();
    });
    const requests = [];
    await page.route('**/api/player/control', async route => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, data: {} } });
    });
    const range = page.locator('#playback-sheet-seek');
    await range.waitFor({ state: 'visible' });
    await range.evaluate(node => node.blur());
    assert.equal(await range.evaluate(node => node.matches(':focus')), false);
    const rect = await range.boundingBox();
    assert.equal(rect.height, 44);
    let response = page.waitForResponse(value => value.url().endsWith('/api/player/control'));
    await range.click({ position: { x: rect.width / 2, y: rect.height / 2 } });
    await response;
    await page.waitForFunction(() => !state.playerControlPendingAction);
    assert.equal(await range.evaluate(node => node.matches(':focus')), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, 'seek-absolute');
    const before = Number(await range.inputValue());
    response = page.waitForResponse(value => value.url().endsWith('/api/player/control'));
    await page.keyboard.press('ArrowRight');
    await response;
    await page.waitForFunction(() => !state.playerControlPendingAction);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].target_seconds > before);
    const dragBounds = await range.boundingBox();
    const start = Number(await range.inputValue()) / Number(await range.getAttribute('max'));
    await page.mouse.move(dragBounds.x + 5 + start * (dragBounds.width - 10), dragBounds.y + dragBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBounds.x + 5 + 0.75 * (dragBounds.width - 10), dragBounds.y + dragBounds.height / 2, { steps: 5 });
    assert.equal(await page.evaluate(() => state.playbackSheetSeekScrubbing), true);
    assert.equal(requests.length, 2, 'Dragging previews locally until release');
    const dragged = Number(await range.inputValue());
    await page.evaluate(() => paintPlaybackClockSurfaces());
    assert.equal(Number(await range.inputValue()), dragged, 'Clock updates must preserve the drag');
    response = page.waitForResponse(value => value.url().endsWith('/api/player/control'));
    await page.mouse.up();
    await response;
    await page.waitForFunction(() => !state.playerControlPendingAction);
    assert.equal(requests.length, 3);
    assert.ok(Math.abs(requests[2].target_seconds - 90) <= 1);
    await range.evaluate(node => { node.value = '90'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.evaluate(() => state.playbackSheetSeekScrubbing), true);
    await range.dispatchEvent('pointercancel');
    assert.equal(await page.evaluate(() => state.playbackSheetSeekScrubbing), false);
    assert.equal(requests.length, 3, 'Cancellation must not seek');
    await page.evaluate(() => closePlaybackSheet());
    assert.equal(await range.evaluate(node => node.classList.contains('is-engaged')), false);
  });

  test(`${name} isolated audience receives download progress without recreating media or changing authority`, {
    skip: nativeLimit, timeout: 120000,
  }, async t => {
    const directory = mkdtempSync(path.join(root, '.tmp/audience progress 中文 & '));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const result = await runNative(process.execPath,
      ['tests/browser/native_presentation_output_relay.cjs', desktop, directory, name.toLowerCase()],
      process.env, 100000);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /audience download progress: PASS/);
  });

  test(`${name} Host titles reserve glyph paint room in single-line, two-line and scrolling layouts`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    const { page } = await open(t, engine);
    for (const width of [1920, 700]) {
      await page.setViewportSize({ width, height: 1080 });
      for (const family of ['', 'Arial, sans-serif']) {
        const paint = await page.evaluate(family => {
          elements.currentTitle.style.fontFamily = family;
          elements.currentTitleText.textContent = 'gypqj'; measurePersistentStage();
          const range = document.createRange(); range.selectNodeContents(elements.currentTitleText);
          const glyph = range.getBoundingClientRect(), text = elements.currentTitleText.getBoundingClientRect();
          return { top: glyph.top - text.top, bottom: text.bottom - glyph.bottom };
        }, family);
        assert.ok(paint.top >= 2 && paint.bottom >= 2, `Glyph bounds need paint room: ${JSON.stringify(paint)}`);
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => {
      elements.currentTitle.style.fontFamily = '';
      elements.currentTitle.style.maxWidth = '300px';
      elements.currentTitleText.textContent = 'gypqj 演唱版本 gypqj ending'; measurePersistentStage();
    });
    await page.waitForFunction(() => elements.currentTitle.dataset.visibleLines === '2');
    assert.equal(await page.locator('#current-title').evaluate(node => node.classList.contains('is-scrolling')), false);
    await page.evaluate(() => {
      elements.currentTitleText.textContent = 'gypqj 很长的歌曲标题 '.repeat(30); measurePersistentStage();
    });
    await page.waitForFunction(() => elements.currentTitle.classList.contains('is-scrolling'));
    assert.equal(await page.locator('#current-title-text').evaluate(node => getComputedStyle(node).animationName), 'text-marquee-loop');
  });

  test(`${name} Host console and transition use shared queue badges without cache borders or media replacement`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    const { page } = await open(t, engine);
    await page.evaluate(() => {
      fetchState = async () => {}; state.eventSource?.close();
      state.data.playlist = [
        { id: 'next-song', display_title: '下一首 gypqj', requester_name: 'Alice', selected_durations: [120], cache_status: 'pending' },
        { id: 'failed-song', display_title: '缓存失败的歌曲', requester_name: 'Alice', selected_durations: [150], cache_status: 'failed' },
        { id: 'ready-song', display_title: '已缓存的歌曲', requester_name: 'Alice', selected_durations: [180], cache_status: 'ready' },
      ];
      state.data.current_item = { id: 'current-song', display_title: '当前歌曲', cache_status: 'failed', cache_message: '状态 <unsafe>' };
      state.presentationSession = { ...state.presentationSession, mode: 'localDualScreen', phase: 'active' };
      applyPresentationCompositionDom(state.presentationSession.generation, 'stageOnly');
      window.statusMedia = document.createElement('video'); elements.playerFrame.appendChild(window.statusMedia);
      window.statusNowCard = elements.presentationHostAnnouncement.querySelector('.player-delay-now-row');
      window.statusQueueCards = [...elements.presentationHostAnnouncement.querySelectorAll('.player-delay-list-row')];
    });
    for (const width of [1920, 700]) {
      await page.setViewportSize({ width, height: 1080 });
      for (const theme of ['light', 'dark', 'blue']) {
        for (const cacheStatus of ['pending', 'queued', 'downloading', 'failed', 'ready', '', 'unknown']) {
          const result = await page.evaluate(({ theme, cacheStatus }) => {
            applyTheme(theme);
            const surface = elements.presentationHostAnnouncement;
            const before = surface.querySelector('.player-delay-now-row').getBoundingClientRect();
            state.data.playlist[0].cache_status = cacheStatus;
            state.data.playlist[0].cache_progress = 40;
            elements.currentTitleText.textContent = '当前歌曲';
            renderCurrentPresentationScene(); renderPresentationHostSurface();
            const frame = elements.playerFrame, border = getComputedStyle(frame, '::after');
            const colors = {};
            for (const token of ['red', 'green', 'muted', 'accent']) {
              const probe = document.createElement('span'); probe.style.color = `var(--${token})`; frame.appendChild(probe);
              colors[token] = getComputedStyle(probe).color; probe.remove();
            }
            const cards = [...surface.querySelectorAll('.player-delay-now-row, .player-delay-list-row')];
            const after = cards[0].getBoundingClientRect();
            return { frameState: frame.hasAttribute('data-cache-state'), frameBorder: border.borderTopStyle,
              cards: cards.map(card => {
                const stroke = getComputedStyle(card, '::after');
                const badge = card.querySelector('.queue-order'), style = getComputedStyle(badge);
                const label = badge.querySelector('.queue-badge-label'), error = badge.querySelector('.queue-badge-error');
                const icon = card.querySelector('.queue-badge-play');
                const box = badge.getBoundingClientRect(), bounds = card.getBoundingClientRect();
                const aligned = [...card.querySelectorAll('.player-delay-song-title,.player-delay-requester,.player-delay-duration')]
                  .map(node => getComputedStyle(node).textAlign);
                return { state: badge.dataset.cacheState || '', border: stroke.borderTopStyle,
                  number: label.textContent, labelHidden: getComputedStyle(label).display === 'none',
                  playHidden: !icon || getComputedStyle(icon).display === 'none',
                  cross: getComputedStyle(error).display !== 'none', color: style.color, badgeBorder: style.borderTopColor,
                  radius: style.borderTopLeftRadius, size: [box.width, box.height], aligned,
                  inside: box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom };
              }), colors, media: window.statusMedia.isConnected,
              preserved: cards[0] === window.statusNowCard && cards.slice(1).every((card, index) => card === window.statusQueueCards[index]),
              geometry: [before.width, before.height, after.width, after.height],
              heading: parseFloat(getComputedStyle(surface.querySelector('.player-delay-heading')).fontSize),
              headingColor: getComputedStyle(surface.querySelector('.player-delay-heading')).color,
              headingText: surface.querySelector('.player-delay-heading').textContent,
              expectedHeading: t('player.followingQueue'),
              subheadingHidden: getComputedStyle(surface.querySelector('.player-delay-section-title')).display === 'none',
              padding: ['Top', 'Right', 'Bottom', 'Left'].map(side => getComputedStyle(surface.querySelector('.player-delay-card'))[`padding${side}`]),
              song: parseFloat(getComputedStyle(surface.querySelector('.player-delay-song-title')).fontSize),
              listSong: parseFloat(getComputedStyle(surface.querySelector('.player-delay-list-row .player-delay-song-title')).fontSize),
              metadata: parseFloat(getComputedStyle(surface.querySelector('.player-delay-requester')).fontSize),
              line: getComputedStyle(surface.querySelector('.player-delay-song-title')).lineHeight,
              containerHeight: surface.clientHeight };
          }, { theme, cacheStatus });
          const failed = cacheStatus === 'failed';
          assert.equal(result.frameState, false, 'Playback must not own song-card cache state');
          assert.equal(result.frameBorder, 'none', 'No cache stroke around the playback area');
          const [primary, failure, ready] = result.cards;
          assert.equal(primary.state, cacheStatus === 'queued' ? 'pending' : ['pending', 'downloading', 'failed', 'ready'].includes(cacheStatus) ? cacheStatus : '');
          assert.equal(primary.color, result.colors[failed ? 'red' : cacheStatus === 'ready' ? 'green' : 'muted']);
          assert.equal(primary.cross, failed); assert.equal(primary.labelHidden, failed);
          assert.equal(failure.state, 'failed'); assert.equal(failure.color, result.colors.red);
          assert.equal(failure.cross, true); assert.equal(failure.labelHidden, true);
          assert.equal(ready.state, 'ready'); assert.equal(ready.color, result.colors.green);
          assert.equal(ready.cross, false); assert.equal(ready.labelHidden, false);
          assert.deepEqual(result.cards.map(card => card.number), ['1', '2', '3'], 'The console primary is queue item 1');
          for (const card of result.cards) {
            assert.equal(card.border, 'none', 'No cache outline around any song card');
            assert.equal(card.playHidden, true, 'The console uses numbers for every song');
            assert.equal(card.radius, '50%'); assert.equal(card.size[0], card.size[1]);
            assert.deepEqual(card.aligned, ['left', 'left', 'right'], 'Titles/requesters align left and durations align right');
            assert.equal(card.inside, true, `${theme}/${width}: badge fits the card`);
          }
          assert.equal(result.preserved, true, 'Cache-only changes preserve the song-card nodes');
          assert.deepEqual(result.geometry.slice(0, 2), result.geometry.slice(2), 'Cache badges cannot change card geometry');
          assert.equal(result.media, true, 'State styling must not replace media');
          assert.equal(result.heading, 24, 'The console uses the Host title size');
          assert.equal(result.headingColor, result.colors.accent, 'The following queue heading keeps the theme accent');
          assert.equal(result.headingText, result.expectedHeading);
          assert.equal(result.subheadingHidden, true, 'The redundant following-queue subtitle reserves no space');
          assert.deepEqual(result.padding, ['16px', '16px', '16px', '16px']);
          // Independent original console ratios, rather than production-generated expectations.
          const bounded = (minimum, ratio, maximum) => Math.min(maximum, Math.max(minimum, result.containerHeight * ratio));
          assert.ok(Math.abs(result.song - bounded(15, 0.055, 27)) < 0.1, JSON.stringify(result));
          assert.ok(Math.abs(result.listSong - bounded(13, 0.042, 20)) < 0.1, JSON.stringify(result));
          assert.ok(Math.abs(result.metadata - bounded(11, 0.036, 17)) < 0.1, JSON.stringify(result));
          assert.ok(Math.abs(parseFloat(result.line) - result.song * 1.28) < 0.1);
        }
      }
    }
    await page.evaluate(() => {
      state.localAdvanceOverlayPrimaryItem = structuredClone(state.data.playlist[0]);
      state.localAdvanceOverlayFollowItems = structuredClone(state.data.playlist.slice(1));
      state.localAdvanceDelayDeadline = Date.now() + 60000;
      state.data.playlist = state.data.playlist.map(item => ({ ...item, cache_status: 'downloading' }));
      renderCurrentPresentationScene();
    });
    const transition = page.locator('#player-frame > .player-delay-overlay');
    assert.deepEqual(await transition.locator('.player-delay-now-row, .player-delay-list-row')
      .evaluateAll(cards => cards.map(card => card.dataset.cacheState)), ['downloading', 'downloading', 'downloading'],
    'Frozen transition labels still follow fresh cache snapshots');
    const transitionIcon = await transition.locator('.queue-badge-play').evaluate(node => ({
      path: node.querySelector('path').getAttribute('d'), viewBox: node.getAttribute('viewBox'),
      display: getComputedStyle(node).display,
      reference: document.querySelector('#queue-current-icon-wrap .icon-play path').getAttribute('d'),
    }));
    assert.equal(transitionIcon.path, 'M8 5v14l11-7z');
    assert.equal(transitionIcon.path, transitionIcon.reference, 'Transition uses the exact queue play glyph');
    assert.equal(transitionIcon.viewBox, '0 0 24 24'); assert.notEqual(transitionIcon.display, 'none');
    assert.equal(await page.locator('#player-frame').evaluate(frame => getComputedStyle(frame, '::after').borderTopStyle), 'none');
    await page.evaluate(() => {
      state.localAdvanceOverlayPrimaryItem = { ...state.localAdvanceOverlayPrimaryItem, item_incarnation_id: 'original-song', cache_status: 'pending' };
      state.data.playlist[0] = { ...state.data.playlist[0], item_incarnation_id: 'different-song', cache_status: 'failed' };
      renderCurrentPresentationScene();
    });
    assert.equal(await transition.locator('.player-delay-now-row').getAttribute('data-cache-state'), 'pending',
      'Reusing an item ID cannot borrow cache state from a different incarnation');
    await page.evaluate(() => {
      state.localAdvanceOverlayPrimaryItem.cache_status = 'failed'; renderCurrentPresentationScene();
    });
    assert.equal(await transition.locator('.queue-badge-play').evaluate(node => getComputedStyle(node).display), 'none');
    assert.equal(await transition.locator('.player-delay-play-icon .queue-badge-error').evaluate(node => getComputedStyle(node).display), 'block');
    for (const [language, heading] of [['zh', '后续点歌列表'], ['en', 'Following Request List'], ['ja', '後続の予約リスト']]) {
      await page.evaluate(language => { setLanguage(language); renderPresentationHostSurface(); }, language);
      assert.equal(await page.locator('#presentation-host-announcement .player-delay-heading').innerText(), heading);
      assert.equal(await page.locator('#presentation-host-announcement .player-delay-section-title').isVisible(), false);
      assert.deepEqual(await page.locator('#presentation-host-announcement .queue-badge-label').allTextContents(), ['1', '2', '3']);
    }
    await page.evaluate(() => {
      state.localAdvanceDelayDeadline = 0;
      state.localAdvanceOverlayPrimaryItem = null;
      state.localAdvanceOverlayFollowItems = null;
      state.data.playlist = []; renderPresentationHostSurface();
    });
    assert.equal(await page.locator('#presentation-host-announcement .player-delay-now-row').evaluate(card =>
      getComputedStyle(card, '::after').borderTopStyle), 'none', 'An empty queue placeholder has no cache stroke');
    assert.equal(await page.locator('#presentation-host-announcement .player-delay-play-icon').evaluate(node =>
      getComputedStyle(node).visibility), 'hidden', 'An empty queue cannot claim item 1');
  });

  test(`${name} shared UP badges align in search, detail and wrapped Remote playback metadata`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    for (const role of ['host', 'remote']) {
      const { page } = await open(t, engine, role);
      for (const family of ['', 'Arial, sans-serif']) {
        const alignment = await page.evaluate(family => {
          const area = document.createElement('div'); area.style.cssText = 'position:fixed;left:20px;top:100px;z-index:9999;width:220px';
          area.style.fontFamily = family;
          const search = document.createElement('div'); search.className = 'search-result-owner owner-badge-label'; search.style.fontSize = '12px';
          renderOwnerBadgeLabel(search, 'UP 主 gypqj');
          const detail = document.createElement('div');
          window.BilikaraSongDetail.renderOwnerLabel(detail, {}, 'UP 主 gypqj');
          area.append(search, detail); document.body.appendChild(area);
          const rows = [search, detail];
          if (document.documentElement.dataset.uiClient === 'remote') {
            const field = document.createElement('div'); field.className = 'playback-metadata-field'; field.dataset.playbackMetadataField = 'owner';
            const owner = document.createElement('div'); owner.className = 'current-owner-line owner-badge-label';
            renderOwnerBadgeLabel(owner, 'UP 主 gypqj '.repeat(8)); field.appendChild(owner); area.appendChild(field); rows.push(owner);
          }
          const result = rows.map(row => {
            const badge = row.querySelector('.owner-badge'), label = row.querySelector('.owner-badge-name, strong');
            const border = badge.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(label);
            const line = range.getClientRects()[0], glyphRange = document.createRange(); glyphRange.selectNodeContents(badge);
            const glyph = glyphRange.getBoundingClientRect();
            return { center: border.y + border.height / 2 - (line.y + line.height / 2),
              topRoom: glyph.top - border.top, bottomRoom: border.bottom - glyph.bottom,
              transform: getComputedStyle(badge).transform, margin: getComputedStyle(badge).marginTop };
          });
          area.remove(); return result;
        }, family);
        for (const row of alignment) {
          assert.equal(row.transform, 'none'); assert.equal(row.margin, '0px');
          assert.ok(Math.abs(row.center) < 1.5, `${role} ${family}: ${JSON.stringify(row)}`);
          assert.ok(row.topRoom >= 0 && row.bottomRoom >= 0, `UP glyph must fit its border: ${JSON.stringify(row)}`);
        }
      }
    }
  });

  test(`${name} ordinary user guidance stays neutral and drag deletion retains a stable target through snapshots`, {
    skip: nativeLimit, timeout: 60000,
  }, async t => {
    const { page, host } = await open(t, engine);
    await page.locator('#work-rail-users').click();
    await page.evaluate(() => { fetchState = async () => {}; state.eventSource?.close(); });
    for (const theme of ['light', 'dark', 'blue']) {
      const colors = await page.evaluate(theme => {
        applyTheme(theme); state.sessionUserEditor.render({ ...state.data, session_user_entries: [] });
        const guidance = getComputedStyle(document.querySelector('.session-user-empty'));
        const queue = getComputedStyle(document.querySelector('.queue-empty'));
        return { guidance: guidance.color, queue: queue.color, weight: guidance.fontWeight };
      }, theme);
      assert.equal(colors.guidance, colors.queue, theme);
      assert.equal(colors.weight, '400');
    }
    await page.evaluate(() => state.sessionUserEditor.render(state.data));
    const drag = await page.evaluate(() => {
      const editor = state.sessionUserEditor;
      editor.beginDrag(editor.list.querySelector('.session-user-badge'));
      editor.render(state.data);
      const enabled = !editor.trash.disabled;
      const slot = editor.trash.closest('.session-user-trash-slot'), box = slot.getBoundingClientRect();
      const event = type => new DragEvent(type, { bubbles: true, dataTransfer: new DataTransfer(),
        clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
      editor.trash.dispatchEvent(event('dragover'));
      const highlighted = editor.trash.classList.contains('drag-over');
      editor.trash.dispatchEvent(new DragEvent('dragleave', { bubbles: true,
        relatedTarget: editor.trash.querySelector('path'), clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
      const staysHighlighted = editor.trash.classList.contains('drag-over');
      slot.dispatchEvent(new DragEvent('dragleave', { bubbles: true, clientX: box.right + 20, clientY: box.bottom + 20 }));
      const clearsOutside = !editor.trash.classList.contains('drag-over');
      editor.finishDrag();
      return { enabled, highlighted, staysHighlighted, clearsOutside, released: editor.trash.disabled };
    });
    assert.deepEqual(drag, { enabled: true, highlighted: true, staysHighlighted: true, clearsOutside: true, released: true });
    await page.locator('.session-user-badge').dragTo(page.locator('.session-user-trash-slot'));
    await page.waitForFunction(() => !state.sessionUserEditor.busy);
    assert.deepEqual((await host.api('/api/state')).session_users, [], 'Actual native drag/drop deletes only on drop');
    assert.equal(await page.evaluate(() => Boolean(state.sessionUserEditor.drag)), false);
  });
}

test('actual local-library HTTP search counts and renders unique videos across overlapping sources', {
  skip: nativeLimit, timeout: 60000,
}, async t => {
  const { page, home, host } = await open(t, chromium);
  const files = {
    'gatcha_uids.json': { schema_version: 2, uids: ['42'], profiles: {} },
    'gatcha_cache.json': { schema_version: 3, uids: { '42': [
      { bvid: 'BV1xx411c7mD', title: 'Song original' },
      { bvid: 'BV1z84y1p7oS', title: 'Song second' },
    ] }, profiles: {} },
    'gatcha_favlist.json': { schema_version: 2, items: [
      { bvid: 'BV1xx411c7mD', title: 'Song original', fav_uid: '42', fav_folder_id: '10' },
      { bvid: 'BV1xx411c7mD', title: 'Song original', fav_uid: '42', fav_folder_id: '20' },
      { bvid: 'BV0000000001', title: 'Song favorite' },
    ], folders: [] },
  };
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(home, name), JSON.stringify(value), 'utf8');
  const first = await host.api('/api/gatcha/search?q=Song&limit=2'), second = await host.api('/api/gatcha/search?q=Song&limit=2&offset=2');
  assert.equal(first.matched_count, 3);
  assert.deepEqual(first.items.map(item => item.bvid), ['BV1xx411c7mD', 'BV1z84y1p7oS']);
  assert.deepEqual(second.items.map(item => item.bvid), ['BV0000000001']);
  assert.equal(second.has_more, false);
  await page.locator('#work-rail-request').click();
  await page.locator('[data-request-view="search"]').click();
  await page.locator('[data-search-mode="local"]').click();
  await page.locator('#search-query').fill('Song');
  await page.locator('#search-button').click();
  await page.waitForFunction(() => state.searchModeState.local.items.length === 3 && !state.searchModeState.local.loading);
  assert.deepEqual(await page.evaluate(() => state.searchModeState.local.items.map(item => item.bvid)), ['BV1xx411c7mD', 'BV1z84y1p7oS', 'BV0000000001']);
  assert.equal(await page.locator('#search-results .search-result-item').count(), 3);
});
