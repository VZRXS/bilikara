import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { chromium, webkit } from 'playwright';

const require = createRequire(import.meta.url);
const qrcode = require('../static/qrcode-generator.js');
const origin = 'http://audience.test';
const pairing = 'http://192.168.40.11:18080/remote?test=first';
const replacement = 'http://192.168.40.12:18080/remote?test=second';
const session = {
  generation: 42, mode: 'localDualScreen', phase: 'active', controllerReady: true,
  playbackAuthority: 'host', mediaRendererOwner: 'host',
};
const types = { html: 'text/html', js: 'text/javascript', json: 'application/json', css: 'text/css' };

for (const engine of [chromium, webkit]) {
  test(`${engine.name()} Audience generates a scannable pairing QR without a network fallback`, { timeout: 30_000 }, async (t) => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    for (const native of [false, true]) {
      await t.test(native ? 'iOS presentation bridge' : 'desktop presentation bridge', async () => {
        const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
        try {
          const external = [];
          const pageErrors = [];
          page.on('request', request => {
            if (!request.url().startsWith(origin + '/') && !request.url().startsWith('data:')) external.push(request.url());
          });
          page.on('pageerror', error => pageErrors.push(error.message));
          await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            const name = url.pathname.slice(1);
            const contentType = types[name.split('.').at(-1)];
            if (!/^[a-z0-9.-]+$/i.test(name) || !contentType) return route.fulfill({ status: 404 });
            try {
              const body = await readFile(new URL('../static/' + name, import.meta.url));
              return route.fulfill({
                body, contentType,
                headers: { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'" },
              });
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              return route.fulfill({ status: 404 });
            }
          });
          await page.addInitScript(({ session, native }) => {
            if (native) {
              window.BilikaraHostPresentation = {
                platform: 'ios',
                postMessage(raw) {
                  const { id, command } = JSON.parse(raw);
                  if (command === 'get_presentation_session') {
                    queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, ok: true, data: session }) }));
                  }
                },
              };
              window.emitMaster = payload => window.dispatchEvent(new CustomEvent('bilikara-native-presentation', {
                detail: { name: 'master-state', payload },
              }));
            } else {
              const listeners = new Map();
              window.__TAURI__ = {
                core: { invoke: async () => session },
                event: { listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } },
              };
              window.emitMaster = payload => listeners.get('bilikara-presentation-output-state')({ payload });
            }
          }, { session, native });
          await page.goto(origin + '/controller.html?presentationGeneration=42');
          assert.equal(await page.title(), 'bilikara Stage');
          await page.waitForFunction(() => !document.querySelector('#controller-exit').disabled);
          await page.addScriptTag({ url: '/qr-decoder.js' });

          let sequence = 0;
          const send = async (access, remoteMenuVisible = false) => page.evaluate(({ access, sequence, remoteMenuVisible }) => {
            window.emitMaster(BilikaraPresentationSync.makeEnvelope('master-state', {
              scene: { generation: 42 }, clock: {}, language: 'en', remoteAccess: access, remoteMenuVisible,
            }, { senderId: 'fixture-host', sequence, sentAt: Date.now() }));
          }, { access, sequence: ++sequence, remoteMenuVisible });
          const imgSelector = '#controller-remote-qr-image';
          const qr = page.locator(imgSelector);
          const exit = page.locator('#controller-exit');
          async function decode() {
            await page.waitForFunction(selector => {
              const image = document.querySelector(selector);
              return image.complete && image.naturalWidth > 0 && !image.classList.contains('hidden');
            }, imgSelector);
            return qr.evaluate(image => {
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 420;
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = 'white';
              ctx.fillRect(0, 0, 420, 420);
              ctx.drawImage(image, 30, 30, 360, 360);
              return window.jsQR(ctx.getImageData(0, 0, 420, 420).data, 420, 420)?.data;
            });
          }

          await send({ preferred_url: pairing, connected_count: 1 }, native);
          await page.waitForFunction(url => document.querySelector('#controller-remote-url-link').href === url, pairing);
          assert.match(await qr.getAttribute('src') || '', /^data:image\/svg\+xml,/, 'generate the QR locally when the Host sends only its pairing address');
          assert.equal(await decode(), pairing);
          if (native) {
            assert.equal(await exit.getAttribute('aria-expanded'), 'true');
            await page.keyboard.press('Escape');
            assert.equal(await exit.getAttribute('aria-expanded'), 'false');
          }
          const staleLoad = await qr.evaluateHandle(image => image.onload);
          const initialSrc = await qr.getAttribute('src');
          await send({ preferred_url: pairing, connected_count: 2 }, native);
          await page.waitForFunction(() => document.querySelector('[data-local-connection-count]').textContent === '2');
          assert.equal(await qr.getAttribute('src'), initialSrc);
          await send({ local_url: replacement }, native);
          await page.waitForFunction(url => document.querySelector('#controller-remote-url-link').href === url, replacement);
          assert.equal(await decode(), replacement);
          if (native) assert.equal(await exit.getAttribute('aria-expanded'), 'false');

          const hostCode = qrcode(0, 'M');
          hostCode.addData(replacement, 'Byte');
          hostCode.make();
          const hostSvg = 'data:image/svg+xml;base64,' + Buffer.from(hostCode.createSvgTag(5, 0)).toString('base64');
          await send({ preferred_url: replacement, qr_image: hostSvg });
          await page.waitForFunction(src => document.querySelector('#controller-remote-qr-image').getAttribute('src') === src, hostSvg);
          assert.equal(await decode(), replacement);

          await send({});
          await page.waitForFunction(() => !document.querySelector('#controller-remote-url-link').hasAttribute('href'));
          await staleLoad.evaluate(callback => callback());
          await staleLoad.dispose();
          assert.equal(await qr.getAttribute('src'), null);
          assert.equal(await qr.evaluate(image => image.classList.contains('hidden')), true);
          assert.deepEqual(external, []);
          assert.deepEqual(pageErrors, []);
        } finally {
          await page.close();
        }
      });
    }
  });
}
