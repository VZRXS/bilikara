// Actual shared Host HTTP and rendered controls. Linux touch-capable browser
// fixtures cannot qualify the native iOS long-press callout itself.
import assert from 'node:assert/strict';
import {test, before} from 'node:test';
import {mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {buildNativeAlpha, buildNativeHost} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

let alpha, desktop;
before(async()=>{
  if(process.platform!=='linux')return;
  alpha=await buildNativeAlpha();desktop=await buildNativeHost();
},{timeout:300000});

for(const[platform,engine]of[['desktop',chromium],['android',chromium],['ios',webkit]])test(`${platform} action labels resist selection while native browsing, rename and URL copying remain usable`,
  {skip:process.platform!=='linux',timeout:90000},async t=>{
    const home=ownedDirectory('control selection');t.after(()=>rmSync(home,{recursive:true,force:true}));
    const host=await RunningHost.start(platform==='desktop'?desktop:alpha,home,platform==='desktop'
      ?['--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')]:[home,path.join(root,'static')],isolatedEnvironment(home),platform!=='desktop');
    t.after(()=>host.close());await host.api('/api/session-users/add',{name:'Editable singer'});
    const browser=await engine.launch();t.after(()=>browser.close());
    const context=await browser.newContext({viewport:{width:platform==='desktop'?700:393,height:844},hasTouch:true});
    await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
    const items=Array.from({length:80},(_,i)=>({bvid:'BV'+String(i+1).padStart(10,'0'),title:'Song '+(i+1),owner_name:'Fixture'}));
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!==host.base)return route.abort();
      if(url.pathname==='/api/catalog/search'){
        const offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));
        return route.fulfill({json:{ok:true,data:{items:items.slice(offset,offset+limit),matched_count:80,has_more:offset+limit<80,next_offset:Math.min(80,offset+limit)}}});
      }
      if(platform==='ios'&&['/','/index.html'].includes(url.pathname)){
        const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"','data-host-platform="ios"')});
      }
      return route.continue();
    });
    const page=await context.newPage(),errors=[],consoleErrors=[],httpErrors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(['error','warning'].includes(m.type()))consoleErrors.push(m.text());});
    page.on('response',r=>{if(new URL(r.url()).origin===host.base&&r.status()>=400)httpErrors.push([new URL(r.url()).pathname,r.status()]);});
    await page.goto(host.base);await page.waitForFunction(()=>state.hasValidStateResponse);
    assert.equal(await page.title(),'bilikara host');assert.equal(new URL(page.url()).origin,host.base);
    assert.equal(await page.locator('.app-shell').isVisible(),true);
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal,webpack-dev-server-client-overlay').count(),0);
    const go=async name=>{
      await page.locator(platform==='desktop'?`#work-rail-${name}`:`[data-android-page="${name}"]`).click();
      await page.evaluate(()=>Promise.allSettled([...document.querySelectorAll('#host-workspace-region,#android-my-page')].flatMap(n=>n.getAnimations().map(a=>a.finished))));
    };
    const protectedControl=async locator=>{
      const styles=await locator.evaluateAll(nodes=>nodes.flatMap(node=>[node,...node.querySelectorAll('*')]).map(node=>({
        select:getComputedStyle(node).userSelect,callout:getComputedStyle(node).getPropertyValue('-webkit-touch-callout'),supported:CSS.supports('-webkit-touch-callout','none'),tap:getComputedStyle(node).getPropertyValue('-webkit-tap-highlight-color')})));
      assert.ok(styles.length);
      for(const style of styles){assert.equal(style.select,'none');if(style.supported)assert.equal(style.callout,'none');assert.equal(style.tap,'rgba(0, 0, 0, 0)');}
    };
    if(platform!=='desktop'){
      await go('my');
      for(const selector of ['#android-account-title','#android-settings-slot h3','#android-open-settings']){
        const node=page.locator(selector).first();if(await node.count())assert.equal(await node.evaluate(n=>getComputedStyle(n).userSelect),'none',selector);
      }
      const r=await page.locator('#android-account-title').boundingBox();
      await page.mouse.move(r.x+2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width+30,r.y+100,{steps:12});await page.mouse.up();
      assert.equal(await page.evaluate(()=>getSelection().toString()),'','dragging through My labels must not select interface prose');
      const links=await page.locator('.app-shell a[href]').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).userSelect));
      assert.ok(links.length>0);assert.ok(links.every(value=>value==='text'),'actual URL links remain copyable; the inactive login placeholder has no href');
    }
    await go('users');
    const headingStyle = await page.locator('.host-peer-heading:visible').first().evaluate(node => getComputedStyle(node).userSelect);
    assert.equal(headingStyle,'none');
    const copied = await page.evaluate(() => {
      const fixed = document.createElement('div'); fixed.className='fixed-ui-text';
      const details = document.createElement('span');details.className='diagnostic-details';details.textContent='copyable diagnostic';fixed.append(details);document.body.append(fixed);
      const range=document.createRange();range.selectNodeContents(details);getSelection().removeAllRanges();getSelection().addRange(range);
      const result={style:getComputedStyle(details).userSelect,text:getSelection().toString()};
      getSelection().removeAllRanges();fixed.remove();return result;
    });
    assert.deepEqual(copied,{style:'text',text:'copyable diagnostic'});
    const name=page.locator('.session-user-name').first();await name.waitFor({state:'visible'});
    await protectedControl(name);await protectedControl(page.locator('.session-user-tools'));
    await page.keyboard.press('Tab');await page.locator('.session-user-mode-button[data-mode="rename"]').focus();
    assert.notEqual(await page.locator('.session-user-mode-button[data-mode="rename"]').evaluate(n=>getComputedStyle(n).outlineStyle),'none','application keyboard focus remains visible');
    if(platform!=='desktop')await protectedControl(page.locator('#android-host-dock button'));
    // Use real held pointer events without cancelling their defaults in JS.
    const box=await name.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.down();await page.waitForTimeout(750);await page.mouse.up();
    assert.equal(await page.evaluate(()=>getSelection().toString()),'');
    await page.locator('.session-user-mode-button[data-mode="rename"]').click();
    await name.focus();await page.keyboard.press('Enter');
    const input=page.locator('#session-user-rename-input');await input.waitFor({state:'visible'});
    assert.notEqual(await input.evaluate(n=>getComputedStyle(n).userSelect),'none');
    await input.evaluate(n=>n.select());assert.deepEqual(await input.evaluate(n=>[n.selectionStart,n.selectionEnd]),[0,'Editable singer'.length]);
    await input.fill('Renamed singer');await page.locator('.session-user-rename-panel [type="submit"]').click();
    await input.waitFor({state:'hidden'});
    assert.equal((await host.api('/api/state')).session_user_entries[0].name,'Renamed singer');
    await go('request');await page.locator('[data-request-view="search"]').click();
    await page.locator('#shared-search-form input').fill('Song');await page.locator('#shared-search-button').click();
    const pager=page.locator('#request-search-shared .result-pager');
    if(platform==='desktop'){
      await page.locator('#shared-search-results .search-result-title').first().waitFor({state:'visible'});
      assert.equal(await pager.count(),0,'desktop retains its result list instead of the mobile pager');
      const query=page.locator('#shared-search-form input');
      assert.notEqual(await query.evaluate(n=>getComputedStyle(n).userSelect),'none');
      await query.focus();await query.evaluate(n=>n.select());
      assert.deepEqual(await query.evaluate(n=>[n.selectionStart,n.selectionEnd]),[0,4]);
    }else{
    const pageInput=pager.locator('[data-page-input]');await pageInput.waitFor({state:'visible'});
    await protectedControl(pager.locator('[data-page-action]'));await protectedControl(pager.locator('.result-pager-total'));
    assert.notEqual(await pageInput.evaluate(n=>getComputedStyle(n).userSelect),'none');
    await pageInput.focus();await pageInput.evaluate(n=>n.select());
    assert.deepEqual(await pageInput.evaluate(n=>[n.selectionStart,n.selectionEnd]),[0,1]);
    await pageInput.fill('2');await pageInput.press('Enter');
    await page.waitForFunction(()=>document.querySelector('#request-search-shared [data-page-input]').value==='2');
    assert.notEqual(await page.locator('#shared-search-results .search-result-title').first().textContent(),'Song 1');
    }
    if(platform!=='desktop')await go('playback');
    await page.locator('#remote-mini-trigger').click();
    const link=page.locator('#remote-popover-url-link');await link.waitFor({state:'visible'});
    assert.equal(await link.evaluate(n=>getComputedStyle(n).userSelect),'text');
    const url=await link.textContent();assert.match(url,/^http:\/\//);
    await link.evaluate(n=>{const range=document.createRange();range.selectNodeContents(n);getSelection().removeAllRanges();getSelection().addRange(range);});
    assert.equal(await page.evaluate(()=>getSelection().toString()),url);
    if(process.env.BILIKARA_MOBILE_UI_EVIDENCE){
      mkdirSync(process.env.BILIKARA_MOBILE_UI_EVIDENCE,{recursive:true});
      await page.screenshot({path:path.join(process.env.BILIKARA_MOBILE_UI_EVIDENCE,`selection-${platform}.png`)});
    }
    assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);
    assert.deepEqual(consoleErrors.filter(m=>!/^Failed to load resource:/.test(m)),[]);
  });
