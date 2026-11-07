// Actual Rust HTTP/SSE Host; platform markers do not certify UIKit/WebView2.
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test, {before} from 'node:test';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

let alpha;
before(async()=>{if(process.platform==='linux') alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();},{timeout:300000});

for (const [engineName,engine] of Object.entries({chromium,webkit})) {
  for (const platform of ['desktop','ios']) test(`${engineName} ${platform}: shared Desktop/Tablet admission and local control scrolling preserve media`, {
    skip:process.platform!=='linux'&&'Linux rendered browser evidence; physical Apple/Windows gates remain separate',timeout:120000,
  },async t=>{
    const home=mkdtempSync(path.join(tmpdir(),'bilikara-shared-columns-'));
    let host,browser;
    t.after(async()=>{try{if(browser)await browser.close();}finally{try{if(host)await host.close();}finally{rmSync(home,{recursive:true,force:true});}}});
    host=await RunningHost.start(alpha,home,[home,path.join(root,'static')],isolatedEnvironment(home),true);
    browser=await engine.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1024,height:768},hasTouch:true});
    await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
    await context.route('**/*',async r=>{
      const url=new URL(r.request().url());if(url.origin!==host.base)return r.abort();
      if(url.pathname==='/'){
        const response=await r.fetch();return r.fulfill({response,body:(await response.text()).replace('data-host-platform="android"',`data-host-platform="${platform}"`)});
      }return r.continue();
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(host.base);await page.waitForFunction(()=>state.hasValidStateResponse);
    await page.evaluate(()=>{window.keptMedia=[...document.querySelectorAll('video,audio')];});
    const sample=()=>page.evaluate(()=>{
      const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
      const tray=elements.stageControlTray;
      return {columns:document.documentElement.dataset.hostColumns,layout:elements.appShell.dataset.stageControlsLayout,
        left:rect(elements.leftColumn),right:rect(elements.hostWorkspaceRegion),frame:rect(elements.playerFrame),
        tray:rect(tray),client:tray.clientHeight,scroll:tray.scrollHeight,overflow:getComputedStyle(tray).overflowY,
        same:keptMedia.every(n=>n.isConnected&&document.getElementById(n.id)===n),
        viewportOverflow:document.documentElement.scrollWidth>innerWidth+1};
    });
    for(const [width,height] of [[1024,768],[1080,810],[1194,834],[1366,1024],[1280,800],[1440,900]]) {
      await page.setViewportSize({width,height});
      await page.waitForFunction(()=>document.documentElement.dataset.hostColumns==='two');
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const current=await sample();
      assert.ok(current.right.x>=current.left.right+10,JSON.stringify({width,height,...current}));
      assert.ok(['inline-natural','inline-scrollable'].includes(current.layout),JSON.stringify({width,height,...current}));
      assert.ok(current.same&&!current.viewportOverflow);
      assert.ok(current.tray.h>=112&&current.tray.bottom<=current.left.bottom+1);
      if(current.layout==='inline-scrollable') assert.equal(current.overflow,'auto');
      await page.locator('#stage-control-tray').evaluate(n=>{n.scrollTop=n.scrollHeight;});
      const end=await page.locator('#stage-extended-controls > :last-child').boundingBox();
      const after=await sample();
      assert.ok(end.y>=after.tray.y-1&&end.y+end.height<=after.tray.bottom+1,'Last control group is reachable');
      assert.deepEqual(after.frame,current.frame,'Only controls scroll, never the video');
    }
    for(const [width,height] of [[900,700],[700,600],[1024,360]]) {
      await page.setViewportSize({width,height});
      await page.waitForFunction(()=>document.documentElement.dataset.hostColumns==='compact');
      assert.ok((await sample()).same);
    }
    // Admission must not change its own available shell padding/header and
    // oscillate forever at a split-window boundary.
    for(const [width,height]of [[974,768],[976,768],[978,768],[1024,472],[1024,474],[1024,476]]){
      await page.setViewportSize({width,height});
      const stable=await page.evaluate(async()=>{
        const samples=[];for(let i=0;i<8;i++){await new Promise(requestAnimationFrame);samples.push(document.documentElement.dataset.hostColumns);}
        return samples.slice(-4);
      });
      assert.equal(new Set(stable).size,1,JSON.stringify({width,height,stable}));
    }
    await page.setViewportSize({width:1024,height:768});
    await page.evaluate(()=>{document.documentElement.style.fontSize='32px';schedulePersistentStageMeasurement();});
    await page.waitForFunction(()=>document.documentElement.dataset.hostColumns==='compact');
    await page.evaluate(()=>{document.documentElement.style.fontSize='';schedulePersistentStageMeasurement();});
    for(const [width,height] of [[390,844],[844,390]]) {
      await page.setViewportSize({width,height});
      // Auto remains the existing shared preference resolver: phone below 700,
      // compact Desktop-type shell above it, regardless of device label.
      await page.waitForFunction(({width,platform})=>document.documentElement.dataset.hostColumns===(platform!=='desktop'&&width<700?'phone':'compact'),{width,platform});
      assert.ok((await sample()).same);
    }
    assert.deepEqual(errors,[]);
  });
}
