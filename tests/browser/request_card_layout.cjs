// Run with Playwright installed: node tests/browser/request_card_layout.cjs
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const {chromium,webkit}=require('playwright');
const root=path.resolve(__dirname,'../../static')+path.sep;
(async()=>{
for (const [engine,launcher] of Object.entries({chromium,webkit})) {
 const browser=await launcher.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:375,height:850},reducedMotion:'no-preference'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://audit.local/**',async r=>{const name=new URL(r.request().url()).pathname.slice(1);await r.fulfill({contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html',body:name?fs.readFileSync(root+name,'utf8'):'<html><head><title>Compact card behavior</title></head><body></body></html>'})});
 await page.goto('http://audit.local/');
 const html=fs.readFileSync(root+'remote.html','utf8'),sheets=[...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(m=>m[1]);
 await page.evaluate(sheets=>{
 document.documentElement.dataset.uiClient='remote';document.head.insertAdjacentHTML('beforeend',sheets.map(s=>`<link rel="stylesheet" href="${s}">`).join(''));
 document.body.innerHTML='<section class="panel request-panel" style="width:350px"><div id="scroller" style="height:180px;overflow:auto"><button class="follow-up-button" style="width:140px"><span id="long" class="follow-up-name">这是一个很长的歌手名称 A long artist name 長いアーティスト名</span><span class="follow-up-count">12 首</span></button><button class="tag-browser-tag" style="width:140px"><span id="short" class="tag-browser-tag-name">歌手</span><span class="tag-browser-tag-count">12 首</span></button><div style="height:800px"></div></div></section>';
 },sheets);
 await page.waitForFunction(()=>[...document.querySelectorAll('link')].every(n=>n.sheet));
 await page.addScriptTag({url:'http://audit.local/search-result-media.js'});
 await page.waitForFunction(()=>document.querySelector('#long').classList.contains('is-card-title-visible')&&document.querySelector('#long').classList.contains('is-card-title-overflowing'));
 const props=sel=>page.locator(sel).evaluate(n=>({overflow:n.classList.contains('is-card-title-overflowing'),play:getComputedStyle(n.querySelector('.request-card-title-track')).animationPlayState,animation:getComputedStyle(n.querySelector('.request-card-title-track')).animationName,transform:getComputedStyle(n.querySelector('.request-card-title-track')).transform,height:n.closest('button').getBoundingClientRect().height,clip:getComputedStyle(n).textOverflow}));
 assert.equal((await props('#long')).play,'running');assert.equal((await props('#long')).clip,'clip');
 assert.equal((await props('#short')).animation,'none');assert.equal((await props('#short')).overflow,false);
 await page.waitForFunction(()=>{const s=getComputedStyle(document.querySelector('#long .request-card-title-track'));return s.transform!=='none'&&new DOMMatrix(s.transform).m41 < -1},{},{timeout:8000});
 const moving=await props('#long');assert.equal(moving.height,72);
 await page.evaluate(()=>document.querySelector('#scroller').scrollTop=300);
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('#long .request-card-title-track')).animationPlayState==='paused');
 await page.evaluate(()=>document.querySelector('#scroller').scrollTop=0);
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('#long .request-card-title-track')).animationPlayState==='running');
 await page.evaluate(()=>{window.originalButton=document.querySelector('#long').parentElement;document.querySelector('#long').textContent='短名'});
 await page.waitForFunction(()=>!document.querySelector('#long').classList.contains('is-card-title-overflowing'));
 assert.equal((await props('#long')).animation,'none');
 await page.evaluate(()=>document.querySelector('#long').textContent='很长的标题，保持完整且仅在溢出时滚动');
 await page.waitForFunction(()=>document.querySelector('#long').classList.contains('is-card-title-overflowing'));
 await page.evaluate(()=>{const avatar=document.createElement('img');avatar.className='follow-up-avatar';document.querySelector('#long').parentElement.append(avatar)});await page.waitForFunction(()=>document.querySelector('#long .request-card-title-remainder').clientWidth===document.querySelector('#long').clientWidth-32);
 await page.evaluate(()=>document.querySelector('#long').parentElement.style.width='800px');
 await page.waitForFunction(()=>!document.querySelector('#long').classList.contains('is-card-title-overflowing'));
 await page.evaluate(()=>document.querySelector('#long').parentElement.style.width='140px');
 await page.waitForFunction(()=>document.querySelector('#long').classList.contains('is-card-title-overflowing'));
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal((await props('#long')).animation,'none');
 assert(await page.locator('#long .request-card-title-remainder').evaluate(n=>{n.scrollLeft=30;return n.scrollLeft===30}));
 assert(await page.evaluate(()=>window.originalButton===document.querySelector('#long').parentElement));
 await page.evaluate(()=>{window.mutations=0;new MutationObserver(r=>window.mutations+=r.length).observe(document.querySelector('#scroller'),{subtree:true,childList:true,attributes:true,characterData:true})});
 await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>window.mutations),0);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({engine,moving,checks:'short-static, overflow-moves, offscreen-paused, content-resize-responsive, reduced-motion-manual, nodes-retained, no-repeat-mutations',errors}));
 } finally {await browser.close()}
}
})().catch(e=>{console.error(e);process.exitCode=1});
