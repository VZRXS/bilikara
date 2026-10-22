import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {chromium} from 'playwright';

const app = readFileSync(new URL('../static/app.js', import.meta.url),'utf8');
const chrome = app.slice(app.indexOf('function initializeWindowChrome()'),app.indexOf('function initializeHostShell()'));

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
