import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {chromium,webkit} from 'playwright';

const app = readFileSync(new URL('../static/app.js', import.meta.url),'utf8');
const chrome = app.slice(app.indexOf('function initializeWindowChrome()'),app.indexOf('function initializeHostShell()'));
const styles=readFileSync(new URL('../static/styles.css',import.meta.url),'utf8')+readFileSync(new URL('../static/ui-surfaces.css',import.meta.url),'utf8');

// DOM/WebKit checks only. Native dragging, Spaces and AppKit menus require macOS.
for(const engine of [chromium,webkit])test(`${engine.name()} macOS native titlebar avoids a duplicate DOM strip and excludes floating controls`,async()=>{
  const browser=await engine.launch();
  try {
    const context=await browser.newContext({viewport:{width:700,height:600},userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 Version/17.6 Safari/605.1.15'});
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(`<style>${styles}</style><div class="app-shell"><header class="topbar"><div class="host-brand"><h1>bilikara</h1><a href="#project">Project</a></div><div class="window-drag-region" data-tauri-drag-region></div><div class="top-controls"><button>Settings</button><div class="cache-panel" role="dialog">Menu</div><span role="tooltip">Help</span></div></header><main><span class="runtime-settings-select-shell"><select class="runtime-settings-select"><option>Original</option><option>Instrumental</option></select></span></main></div>`);
    const ordinaryInset=await page.locator('.topbar').evaluate(n=>getComputedStyle(n).paddingLeft);
    const ordinaryTop=await page.locator('.app-shell').evaluate(n=>getComputedStyle(n).paddingTop);
    await page.evaluate(chrome=>{
      window.__TAURI__={window:{getCurrentWindow:()=>({})}};
      const elements={topbar:document.querySelector('.topbar'),windowControls:{hidden:true}};
      function schedulePresentationDisplayRefreshFromWindowEvent(){}
      function syncNativePlayerFullscreen(){return Promise.resolve();}
      eval(chrome+'\ninitializeWindowChrome();');
    },chrome);
    assert.equal(await page.locator('.topbar').getAttribute('data-tauri-drag-region'),'deep');
    for(const selector of ['.cache-panel','[role="tooltip"]'])assert.equal(await page.locator(selector).getAttribute('data-tauri-drag-region'),'false');
    for(const width of [700,1024]){
      await page.setViewportSize({width,height:600});
      assert.equal(await page.locator('.topbar').evaluate(n=>getComputedStyle(n).paddingLeft),ordinaryInset,
        'native traffic lights leave the brand on the ordinary left axis');
      assert.equal(await page.locator('.app-shell').evaluate(n=>getComputedStyle(n).paddingTop),ordinaryTop,
        'the native titlebar must not reserve a second 30px strip inside web content');
      assert.equal(await page.locator('.window-drag-region').isVisible(),false);
    }
    const select=page.locator('select');await select.focus();await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    assert.equal(await select.inputValue(),'Instrumental');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

for(const engine of [chromium,webkit])test(`${engine.name()} macOS runtime selects share pill painting and retain native keyboard selection`,async()=>{
  const browser=await engine.launch();
  try{
    const page=await browser.newPage({viewport:{width:700,height:600}});
    await page.setContent(`<style>${styles}</style><span class="runtime-settings-select-shell"><select class="runtime-settings-select"><option>Original</option><option>Instrumental</option></select></span>`);
    await page.evaluate(()=>document.documentElement.dataset.tauriPlatform='macos');
    const shell=page.locator('.runtime-settings-select-shell'),select=page.locator('select');
    for(const systemTheme of ['dark','light']){
      await page.emulateMedia({colorScheme:systemTheme});
      for(const theme of ['light','dark','blue']){
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        assert.equal(await shell.evaluate(n=>getComputedStyle(n).overflow),'visible','AppKit painting and native focus must not be clipped');
        assert.deepEqual(await select.evaluate(n=>{const s=getComputedStyle(n);return [s.height,s.fontSize,s.fontWeight,s.appearance,s.borderRadius];}),['34px','13px','700','none','999px']);
        assert.equal(await shell.evaluate(n=>getComputedStyle(n,'::after').pointerEvents),'none','the custom closed-field arrow must not intercept native select activation');
        assert.equal(await select.evaluate(n=>getComputedStyle(n).colorScheme),theme==='light'?'light':'dark',
          'native menu colors follow the selected app theme when the system theme differs');
      }
    }
    await select.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Tab');
    assert.equal(await select.inputValue(),'Instrumental');
    await page.evaluate(()=>document.documentElement.dataset.tauriPlatform='windows');
    assert.equal(await shell.evaluate(n=>getComputedStyle(n).overflow),'hidden','other WebViews retain their pill painting correction');
    assert.equal(await select.evaluate(n=>getComputedStyle(n).appearance),'auto');
  }finally{await browser.close();}
});

test('Windows drag-region double click retains one owner when resize retargets its release', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'});
    const page = await context.newPage();
    await page.setContent(`<style>header{height:80px;position:relative}#drag{position:absolute;inset:0;width:400px}h1{margin:0;height:80px}</style>
      <header><h1>bilikara</h1><div id="drag" data-tauri-drag-region></div><button>Settings</button></header>`);
    await page.evaluate(chrome => {
      const topbar=document.querySelector('header'), drag=document.querySelector('#drag');
      window.actions=[];
      const appWindow={
        isMaximized:async()=>window.maximized,
        toggleMaximize:async()=>{window.actions.push('web');window.maximized=!window.maximized;},
      };
      window.__TAURI__={window:{getCurrentWindow:()=>appWindow}};
      const elements={topbar,windowControls:{hidden:true}};
      function renderWindowMaximizeState(value){document.body.classList.toggle('is-maximized',value);}
      function initializeNativeMaximizeRegion(){}
      function schedulePresentationDisplayRefreshFromWindowEvent(){}
      function syncNativePlayerFullscreen(){return Promise.resolve();}
      // Tauri 2's injected drag handler handles the second mousedown before
      // the DOM dblclick. Only that native action/resize is simulated here.
      document.addEventListener('mousedown',event=>{
        if(event.button===0&&event.detail===2&&event.target===drag){
          window.actions.push('native');window.maximized=!window.maximized;
          drag.hidden=true;
        }
      });
      eval(chrome+'\ninitializeWindowChrome();');
    },chrome);
    await page.mouse.dblclick(150,35,{delay:30});
    assert.deepEqual(await page.evaluate(()=>actions),['native'],
      'The release/dblclick retargeted to the header must not toggle the already-maximized window again');
    await page.locator('h1').dblclick();
    assert.deepEqual(await page.evaluate(()=>actions),['native','web'],'An independent title double click still works');
    await page.locator('button').dblclick();
    assert.deepEqual(await page.evaluate(()=>actions),['native','web'],'Interactive controls never toggle the window');
  } finally { await browser.close(); }
});
