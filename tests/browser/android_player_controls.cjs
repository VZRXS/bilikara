// Run with Playwright available via NODE_PATH. Optional installed browser:
// BILIKARA_BROWSER_EXECUTABLE=/path/to/chrome node tests/browser/android_player_controls.cjs
// Offline layout/hit-target regression, not an Android audio-output measurement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const markup = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'static/styles.css'), 'utf8');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BILIKARA_BROWSER_EXECUTABLE
      ? { executablePath: process.env.BILIKARA_BROWSER_EXECUTABLE } : {}),
  });
  try {
    for (const [width, height] of [[320, 740], [393, 873], [412, 915], [873, 393]]) {
      for (const density of ['comfortable', 'compact', 'plain']) {
        const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
        await page.route('**/*', route => route.abort());
        await page.setContent('<html data-native-host="true"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>');
        await page.addStyleTag({ content: styles });
        await page.evaluate(({ markup, density }) => {
          const source = new DOMParser().parseFromString(markup, 'text/html');
          const tray = source.querySelector('#stage-control-tray');
          const shell = document.createElement('div');
          shell.className = 'app-shell';
          shell.dataset.stageControlDensity = density;
          shell.innerHTML = '<div class="left-column"></div>';
          document.body.append(shell);
          shell.firstElementChild.append(tray);
          tray.hidden = false;
          tray.inert = false;
          tray.classList.add('is-open');
          tray.style.cssText = 'position:fixed;left:12px;top:12px;width:calc(100vw - 24px);max-height:calc(100dvh - 24px)';
          tray.querySelectorAll('button,input').forEach(control => {
            // Backend availability is outside this offline layout test.
            control.disabled = false;
            control.addEventListener('click', () => { control.dataset.activated = 'true'; });
            control.addEventListener('pointerdown', () => { control.dataset.touched = 'true'; });
          });
        }, { markup, density });
        const controls = page.locator('.stage-extended-controls button:not(.playback-contextual-info-button), .stage-extended-controls input');
        for (const control of await controls.all()) {
          await control.scrollIntoViewIfNeeded();
          const result = await control.evaluate(el => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { label: el.id || el.textContent.trim(), x: r.x, right: r.right, height: r.height,
              hit: hit === el || el.contains(hit) };
          });
          assert(result.x >= 12 && result.right <= width - 12, JSON.stringify({ width, density, ...result }));
          assert(result.hit, JSON.stringify({ width, density, ...result }));
          await control.tap();
          // Range controls begin a drag on pointerdown; they need not emit click.
          const marker = await control.getAttribute('type') === 'range' ? 'data-touched' : 'data-activated';
          assert.equal(await control.getAttribute(marker), 'true', result.label);
        }
        console.log(`PASS Android controls ${width}x${height} ${density}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
