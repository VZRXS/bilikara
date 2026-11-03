// Actual isolated native Host + rendered Remote. Chromium uses real touch
// gestures; WebKit covers geometry and native wheel scroll, not iOS acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';

for(const engine of [chromium,webkit])test(`${engine.name()} Remote sheet columns scroll independently and retain the short-screen fallback`,{timeout:120000,skip:process.platform!=='linux'},async t=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-sheet-columns-'));
  let browser,host;
  t.after(async()=>{await browser?.close();await host?.close();rmSync(home,{recursive:true,force:true});});
  for(const file of ['video.mp4','audio.m4a'])writeFileSync(path.join(home,file),'synthetic layout media');
  host=await RunningHost.start(process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY||await buildNativeAlpha(),home,
    [home,path.join(root,'static'),path.join(home,'video.mp4'),path.join(home,'audio.m4a'),'3'],isolatedEnvironment(home),true);
  await host.api('/api/session-users/add',{name:'Fixture'});
  browser=await engine.launch();
  const context=await browser.newContext({viewport:{width:812,height:375},hasTouch:true,isMobile:engine===chromium});
  await context.addInitScript(()=>{localStorage.setItem('bilikara.update.automatic','false');localStorage.setItem('bilikara.ui.playback-restart-seen.remote.v1','true');});
  const external=[],errors=[],commands=[],measurements=[];
  await context.route('**/*',r=>{if(new URL(r.request().url()).origin===host.base)return r.continue();external.push(r.request().url());return r.abort();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(['/api/player/control','/api/player/next','/api/cache/retry'].includes(new URL(r.url()).pathname))commands.push(r.url());});
  await page.goto(host.base+'/remote');
  await page.waitForFunction(()=>typeof state!=='undefined'&&state.data&&!state.remoteIdentityChecking);
  assert.equal(await page.title(),'bilikara remote');
  await page.evaluate(async()=>applyRemoteIdentity(await apiPost('/api/remote-identity/register',{name:'Fixture',claim:true})));
  await page.locator('#remote-identity-modal').waitFor({state:'hidden'});
  const sheet=page.locator('#playback-sheet'),primary=page.locator('.playback-sheet-primary'),secondary=page.locator('.playback-sheet-secondary');
  const open=async()=>{await page.locator('#playback-dock').tap();await sheet.waitFor({state:'visible'});await page.waitForFunction(()=>!playbackSheetGesture?.active);};
  await open();
  await page.evaluate(()=>{state.eventSource?.close();fetchState=async()=>{};});
  async function layout(width,height,language='zh',cache='ready',long=false){
    await page.setViewportSize({width,height});
    await page.evaluate(({language,cache,long})=>{
      setLanguage(language);
      Object.assign(state.data.current_item,{display_title:long?'长歌曲标题🎤'.repeat(30):'Fixture Song',requester_name:long?'点歌人'.repeat(30):'Fixture',owner_name:long?'Uploader '.repeat(30):'Uploader',cache_status:cache,cache_message:'',cache_download_current_bytes:215*1024*1024,cache_download_total_bytes:233*1024*1024});
      render();applyPlaybackSheetAdaptiveLayout();
    },{language,cache,long});
    await page.waitForFunction(()=>!state.playbackMetadataLayoutFrame);
    return page.evaluate(()=>{
      const body=elements.playbackSheetBody,left=elements.playbackSheetPrimary,right=elements.playbackSheetSecondary;
      const bounds=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const rect=bounds(left);
      return {width:innerWidth,height:innerHeight,twoColumns:playbackSheetUsesTwoColumns(),bodyScroll:body.scrollHeight>body.clientHeight+1,leftScroll:left.scrollHeight>left.clientHeight+1,rightScroll:right.scrollHeight>right.clientHeight+1,
        leftNatural:playbackVisibleChildrenStackHeight(left),leftHeight:left.clientHeight,leftOverflow:getComputedStyle(left).overflowY,leftTouch:getComputedStyle(left).touchAction,
        outside:document.documentElement.scrollWidth>innerWidth,rect,
        buttons:[...left.querySelectorAll('.player-control-row button')].filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden').map(bounds)};
    });
  }
  for(const [width,height] of [[700,320],[812,375],[1024,600]])for(const language of ['zh','en','ja'])for(const cache of ['ready','failed','downloading']){
    const result=await layout(width,height,language,cache,true);measurements.push({...result,language,cache});
    assert.equal(result.twoColumns,true);assert.equal(result.bodyScroll,false);
    assert.equal(result.leftScroll,false,JSON.stringify(result));assert.equal(result.leftOverflow,'hidden');assert.equal(result.leftTouch,'pan-x');
    assert.equal(result.outside,false);
    for(const button of result.buttons){assert.ok(button.left>=result.rect.left-1&&button.right<=result.rect.right+1,JSON.stringify({result,button}));assert.ok(button.bottom<=result.rect.bottom+1);}
  }
  const evidence=process.env.BILIKARA_SHEET_COLUMNS_EVIDENCE;
  if(evidence)mkdirSync(evidence,{recursive:true});
  // Rotation/available-height changes must retire an old song-column offset
  // through the real resize path, without manually calling the layout function.
  await layout(812,240,'zh','downloading',true);
  await primary.evaluate(n=>{n.scrollTop=100;});
  assert.ok(await primary.evaluate(n=>n.scrollTop)>0);
  await page.setViewportSize({width:852,height:393});
  await page.waitForFunction(()=>!state.playbackMetadataLayoutFrame&&elements.playbackSheetPrimary.scrollTop===0);
  assert.equal(await primary.evaluate(n=>n.scrollHeight>n.clientHeight+1),false);
  assert.ok(await page.locator('#current-title').evaluate(n=>n.getBoundingClientRect().top>=elements.playbackSheetPrimary.getBoundingClientRect().top-1));
  await layout(812,375);assert.equal(await secondary.evaluate(n=>n.scrollHeight>n.clientHeight+1),true);
  const fixed=await primary.boundingBox(),right=await secondary.boundingBox();
  await page.mouse.move(right.x+8,right.y+right.height/2);await page.mouse.wheel(0,180);
  await page.waitForFunction(()=>elements.playbackSheetSecondary.scrollTop>0);
  assert.equal(await primary.evaluate(n=>n.scrollTop),0);assert.deepEqual(await primary.boundingBox(),fixed);
  assert.equal(await page.evaluate(()=>elements.playbackSheetBody.scrollTop),0);
  // Right-column scrolling does not dismiss a menu anchored to the fixed left.
  await page.evaluate(()=>{
    state.data.current_item.available_parts=state.data.current_item.available_pages.map((_,i)=>`Track ${i} `+'Long audio track label '.repeat(5));
    render();syncAudioVariantLayout();
  });
  await page.locator('.audio-variant-toggle').tap();
  await secondary.evaluate(n=>{n.scrollTop=0;});
  await page.waitForTimeout(60);
  assert.equal(await page.evaluate(()=>state.audioVariantBarExpanded),true);
  await page.evaluate(()=>setAudioVariantPopoverOpen(false));
  if(engine===chromium){
    const cdp=await context.newCDPSession(page);
    const touch=(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y}]});
    await layout(700,320);const box=await secondary.boundingBox();
    await secondary.evaluate(n=>{n.scrollTop=0;});
    const x=box.x+3,y=box.y+box.height-15;
    await touch('touchStart',x,y);
    for(const dy of [20,50,90,130]){await touch('touchMove',x,y-dy);await page.waitForTimeout(25);}
    await touch('touchEnd');await page.waitForFunction(()=>elements.playbackSheetSecondary.scrollTop>0);
    assert.equal(await page.evaluate(()=>state.playbackSheetOpen&&!playbackSheetGesture.active),true);
    assert.equal(await primary.evaluate(n=>n.scrollTop),0);
    await secondary.evaluate(n=>{n.scrollTop=0;});await page.waitForTimeout(150);
    await touch('touchStart',x,box.y+30);
    for(const dy of [20,50,90,130]){await touch('touchMove',x,box.y+30+dy);await page.waitForTimeout(25);}
    await touch('touchEnd');assert.equal(await page.evaluate(()=>state.playbackSheetOpen&&!playbackSheetGesture.active),true,'right column owns the gesture even at scrollTop=0');
    const left=await primary.boundingBox(),start=left.y+15,distance=320-start-12;
    await touch('touchStart',left.x+20,start);
    for(const p of [.15,.4,.7,1]){await touch('touchMove',left.x+20,start+distance*p);await page.waitForTimeout(25);}
    assert.equal(await page.evaluate(()=>playbackSheetGesture.active),true);
    await touch('touchEnd');await sheet.waitFor({state:'hidden'});await open();
    // Truly short content or enlarged UI must remain reachable by native scroll.
    await layout(812,240,'ja','failed',true);
    assert.equal(await primary.evaluate(n=>n.scrollHeight>n.clientHeight+1),true);
    const short=await primary.boundingBox(),sx=short.x+3,sy=short.y+short.height-8;
    await touch('touchStart',sx,sy);for(const dy of [20,40,65,90]){await touch('touchMove',sx,sy-dy);await page.waitForTimeout(25);}await touch('touchEnd');
    await page.waitForFunction(()=>elements.playbackSheetPrimary.scrollTop>0);
    assert.equal(await page.evaluate(()=>state.playbackSheetOpen&&!playbackSheetGesture.active),true);
    await cdp.detach();
  }
  const short=await layout(812,240,'ja','failed',true);assert.equal(short.leftScroll,true);assert.notEqual(short.leftOverflow,'hidden');
  await layout(700,320,'zh','failed',true);
  await page.evaluate(()=>{
    document.documentElement.style.setProperty('--remote-safe-area-top','40px');
    document.documentElement.style.setProperty('--remote-safe-area-bottom','34px');
    applyPlaybackSheetAdaptiveLayout();
  });
  assert.equal(await primary.evaluate(n=>n.scrollHeight>n.clientHeight+1),true,'real available height, including safe areas, decides the fallback');
  await page.evaluate(()=>{
    document.documentElement.style.removeProperty('--remote-safe-area-top');
    document.documentElement.style.removeProperty('--remote-safe-area-bottom');
  });
  // Returning from a scrolled short column resets its now-unnecessary offset.
  await primary.evaluate(n=>{n.scrollTop=40;});await layout(700,320);
  assert.equal(await primary.evaluate(n=>n.scrollTop),0);
  if(evidence)await page.screenshot({path:path.join(evidence,`${engine.name()}-700x320.png`)});
  await layout(812,375,'en','failed',true);
  if(evidence)await page.screenshot({path:path.join(evidence,`${engine.name()}-812x375.png`)});
  for(const [width,height] of [[640,320],[568,320],[320,568]]){
    const result=await layout(width,height);assert.equal(result.twoColumns,false);assert.equal(result.bodyScroll,true);assert.equal(result.outside,false);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(commands,[]);
  if(evidence)writeFileSync(path.join(evidence,`${engine.name()}-measurements.json`),JSON.stringify(measurements,null,2));
});
