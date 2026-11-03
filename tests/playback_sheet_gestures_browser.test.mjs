// Real Chromium touch input, native Rust Host and synthetic local media.
import assert from 'node:assert/strict';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import visibleBounds from './browser/playback_visible_bounds.cjs';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';

for (const variant of ['morph','slide']) test(`real Remote first-use and ${variant} sheet gestures`,{timeout:100000},async()=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-sheet-'));
  const evidence=path.join(process.env.BILIKARA_RESTART_SCREENSHOTS || mkdtempSync(path.join(tmpdir(),'bilikara-sheet-evidence-')),variant);
  mkdirSync(evidence,{recursive:true});
  let browser,host,passed=false,identityReady=false,phase='setup';
  const errors=[],external=[],commands=[],httpFailures=[],warnings=[],geometry=[];
  try {
    const video=path.join(home,'video.mp4'),audio=path.join(home,'audio.m4a');
    if (process.env.BILIKARA_TEST_MEDIA_VIDEO || process.env.BILIKARA_TEST_MEDIA_AUDIO) {
      assert.ok(process.env.BILIKARA_TEST_MEDIA_VIDEO && process.env.BILIKARA_TEST_MEDIA_AUDIO, 'Both cached synthetic fixtures are required');
      cpSync(process.env.BILIKARA_TEST_MEDIA_VIDEO,video); cpSync(process.env.BILIKARA_TEST_MEDIA_AUDIO,audio);
    } else for (const [file,args] of [[video,['-f','lavfi','-i','color=c=0x224466:s=640x360:r=10:d=120','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p']],
      [audio,['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=120','-af','volume=0.01','-c:a','aac']]]) {
      const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,file],process.env,30000);
      assert.equal(result.status,0,result.stderr);
    }
    const assets=path.join(home,'static');cpSync(path.join(root,'static'),assets,{recursive:true});
    // An owned, trusted comparison build selects the alternate constructor.
    // The product defaults to morph; no URL/storage setting or live DOM changes.
    if (variant==='slide') {
      const file=path.join(assets,'remote.js'),source=readFileSync(file,'utf8');
      const anchor='layout: () => applyPlaybackSheetAdaptiveLayout(),';
      assert.equal(source.split(anchor).length,2);
      writeFileSync(file,source.replace(anchor,anchor+'\n    variant: "slide",'),'utf8');
    }
    host=await RunningHost.start(process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha(),home,
      [home,assets,video,audio,'3'],isolatedEnvironment(home),true);
    browser=await chromium.launch({headless:process.env.BILIKARA_RESTART_HEADED!=='1',args:['--autoplay-policy=no-user-gesture-required']});
    const playerContext=await browser.newContext({viewport:{width:1000,height:800}});
    await playerContext.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    const context=await browser.newContext({viewport:{width:375,height:812},hasTouch:true,isMobile:true,
      recordVideo:{dir:path.join(evidence,'video'),size:{width:375,height:812}}});
    for (const c of [playerContext,context]) {
      await c.addInitScript(()=>{localStorage.setItem('bilikara.update.automatic','false');localStorage.setItem('bilikara.ui.language','zh');});
      await c.route('**/*',route=>{
        if(new URL(route.request().url()).origin===host.base)return route.continue();
        external.push(new URL(route.request().url()).origin);return route.abort();
      });
    }
    const player=await playerContext.newPage(),remote=await context.newPage();
    for(const p of [player,remote]) {
      p.setDefaultTimeout(12000);
      p.on('pageerror',error=>errors.push(error.message));
      p.on('console',message=>{if(['error','warning'].includes(message.type()))warnings.push(message.text());});
      p.on('response',response=>{if(response.status()>=400)httpFailures.push({path:new URL(response.url()).pathname,status:response.status(),beforeIdentity:!identityReady,phase});});
      p.on('request',request=>{if(['/api/player/control','/api/player/next'].includes(new URL(request.url()).pathname))commands.push(request.postDataJSON());});
    }
    await player.goto(host.base);
    await player.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted);
    await remote.goto(host.base+'/remote');
    await remote.locator('#remote-identity-input').fill('Gesture fixture');
    await remote.locator('#remote-identity-submit').click();
    await remote.locator('#remote-identity-modal').waitFor({state:'hidden'});identityReady=true;
    assert.equal(await remote.title(),'bilikara remote');
    const sheet=remote.locator('#playback-sheet'),dock=remote.locator('#playback-dock');
    const menu=remote.locator('.playback-restart-popover'),header=remote.locator('.playback-sheet-status-header');
    const collapse=remote.locator('#playback-sheet-collapse');
    const cdp=await context.newCDPSession(remote);
    await remote.evaluate(fn=>{window.playbackVisibleBounds=(0,eval)('('+fn+')');},visibleBounds.toString());
    const touch=async(type,x=0,y=0)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y}]});
    const screen=async(name)=>{
      const metrics=await remote.evaluate(()=>({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,selection:String(getSelection()),open:state.playbackSheetOpen,active:!!playbackSheetGesture?.active,
        panel:playbackVisibleBounds(document.querySelector('#playback-sheet-panel'))}));
      assert.equal(metrics.overflow,false);assert.equal(metrics.selection,'');
      geometry.push({name,...metrics});await remote.screenshot({path:path.join(evidence,name+'.png')});
    };
    const idle=()=>remote.waitForFunction(()=>!playbackSheetGesture?.active);
    const openByClick=async()=>{await dock.tap();await sheet.waitFor({state:'visible'});await delay(300);};
    const closeByClick=async()=>{await collapse.tap();await sheet.waitFor({state:'hidden'});};
    const clickMotion=async(expanded)=>{
      // Read actual rendered frames around the click, without modifying UI.
      const observed=remote.evaluate(async()=>{
        const frames=[];let seen=false;
        for(let i=0;i<100;i++) {
          await new Promise(resolve=>requestAnimationFrame(resolve));
          const active=!!playbackSheetGesture?.active;
          if(active) {
            seen=true;
            const panel=document.querySelector('#playback-sheet-panel'),handle=document.querySelector('#playback-sheet-collapse');
            const rect=playbackVisibleBounds(panel);
            frames.push({width:rect.width,height:rect.height,dragging:document.querySelector('#playback-sheet').classList.contains('is-dragging'),bar:getComputedStyle(handle,'::after').content});
          } else if(seen) return frames;
        }
        return frames;
      });
      await (expanded?dock:collapse).tap();
      const frames=await observed;
      assert.ok(frames.length>=2,'Click has real intermediate frames');
      assert.ok(frames.every(frame=>!frame.dragging&&frame.bar==='""'),'Click and drag use the same visible handle');
      if(variant==='morph') {
        assert.ok(Math.max(...frames.map(frame=>frame.width))-Math.min(...frames.map(frame=>frame.width))>4,'Click morphs width, rather than sliding a full-width panel');
        assert.ok(Math.max(...frames.map(frame=>frame.height))-Math.min(...frames.map(frame=>frame.height))>30,'Click morphs the surface height');
      }
      await idle();assert.equal(await remote.evaluate(()=>state.playbackSheetOpen),expanded);
      geometry.push({name:expanded?'click-open-frames':'click-close-frames',frames});
    };
    phase='first-use';
    await openByClick();
    await remote.waitForFunction(()=>document.querySelector('.playback-restart-popover').classList.contains('is-hint-open'));
    await delay(220);
    assert.equal(await menu.getAttribute('aria-hidden'),'true');
    assert.equal(await menu.locator('.playback-restart-action').isDisabled(),true);
    assert.equal(await remote.locator('[data-control-action="next-track"]').evaluate(node=>node.tabIndex),0,'Passive preview keeps the original Next keyboard accessible');
    assert.equal(await remote.locator('.playback-restart-next').count(),0,'Preview owns no duplicate Next target');
    assert.equal(await remote.locator('[data-control-action="next-track"]').getAttribute('aria-expanded'),'false');
    await screen('first-use-expanded');
    await remote.waitForFunction(()=>localStorage.getItem('bilikara.ui.playback-restart-seen.remote.v1')==='true');
    await menu.waitFor({state:'hidden'});assert.deepEqual(commands,[]);
    // A separate owned profile has not seen the hint. A touch on its passive
    // extra icon must not click the progress control underneath it.
    const storage=await context.storageState();
    for(const origin of storage.origins) origin.localStorage=origin.localStorage.filter(entry=>entry.name!=='bilikara.ui.playback-restart-seen.remote.v1');
    const hintContext=await browser.newContext({viewport:{width:375,height:812},hasTouch:true,isMobile:true,storageState:storage});
    await hintContext.route('**/*',route=>{
      if(new URL(route.request().url()).origin===host.base)return route.continue();
      external.push(new URL(route.request().url()).origin);return route.abort();
    });
    const hintPage=await hintContext.newPage();
    hintPage.on('pageerror',error=>errors.push(error.message));
    hintPage.on('request',request=>{if(new URL(request.url()).pathname==='/api/player/control')commands.push(request.postDataJSON());});
    await hintPage.goto(host.base+'/remote');
    await hintPage.locator('#remote-identity-modal').waitFor({state:'hidden'});
    await hintPage.locator('#playback-dock').tap();
    await hintPage.waitForFunction(()=>document.querySelector('.playback-restart-popover').classList.contains('is-hint-open'));
    const preview=await hintPage.locator('.playback-restart-popover .playback-restart-action').boundingBox();
    await hintPage.touchscreen.tap(preview.x+preview.width/2,preview.y+preview.height/2);await delay(200);
    assert.equal(await hintPage.locator('.playback-restart-popover').isVisible(),false);
    assert.notEqual(await hintPage.evaluate(()=>localStorage.getItem('bilikara.ui.playback-restart-seen.remote.v1')),'true','An interrupted hint was not completed');
    assert.deepEqual(commands,[],'Passive hint touch cannot seek underneath it');await hintPage.close();
    await closeByClick();await openByClick();await delay(950);
    assert.equal(await menu.isVisible(),false,'Completed hint never repeats');await closeByClick();
    phase='click-morph';
    await clickMotion(true);await clickMotion(false);
    // Escape while click-opening reverses from its current position. A fresh
    // click after settling must own a new animation, not an old callback.
    await dock.tap();await delay(45);await remote.keyboard.press('Escape');
    await idle();await sheet.waitFor({state:'hidden'});
    assert.equal(await remote.locator('.playback-sheet-dock-ghost').count(),0);
    assert.equal(await remote.evaluate(()=>document.querySelector('.remote-shell').inert),false);
    await openByClick();await closeByClick();
    phase='gestures';
    // The hidden seek thumb is a reveal-only first gesture, including its
    // native range default. Only a second real tap submits a seek command.
    await openByClick();
    const seek=remote.locator('#playback-sheet-seek');
    const seekBox=await seek.boundingBox(),seekBefore=commands.length,previousPosition=Number(await seek.inputValue());
    await remote.touchscreen.tap(seekBox.x+seekBox.width*.6,seekBox.y+seekBox.height/2);
    assert.equal(await seek.evaluate(node=>node.classList.contains('is-engaged')),true);
    assert.equal(commands.length,seekBefore,'First tap reveals without a native track jump');
    assert.ok(Math.abs(Number(await seek.inputValue())-previousPosition)<=2,'Reveal keeps the real playback position');
    const seekRequest=remote.waitForRequest(request=>new URL(request.url()).pathname==='/api/player/control');
    await remote.touchscreen.tap(seekBox.x+seekBox.width*.25,seekBox.y+seekBox.height/2);await seekRequest;
    await remote.waitForFunction(()=>!state.playerControlPendingAction);
    assert.equal(commands.length,seekBefore+1); assert.equal(commands.at(-1).action,'seek-absolute');
    commands.splice(seekBefore);
    await closeByClick();
    // Spacious content: the non-control body surface can collapse the sheet.
    await remote.setViewportSize({width:1000,height:700});await openByClick();await idle();
    const body=remote.locator('.playback-sheet-body');
    assert.equal(await body.evaluate(node=>node.scrollHeight>node.clientHeight+1),false);
    let base=await body.boundingBox(),baseX=base.x+3,baseY=base.y+20;
    await touch('touchStart',baseX,baseY);
    for(const dy of [20,80,180,300]){await touch('touchMove',baseX,baseY+dy);await delay(30);}
    assert.equal(await remote.evaluate(()=>playbackSheetGesture.active),true);
    await screen('body-swipe-closing');await touch('touchEnd');await idle();await sheet.waitFor({state:'hidden'});
    await openByClick();
    // An ordinary control keeps its tap/jitter behavior. A deliberate vertical
    // drag from that same real target closes without dispatching its action.
    const play=remote.locator('[data-control-action="toggle-play"]'),controlBox=await play.boundingBox();
    const beforeTap=commands.length;
    for(let i=0;i<2;i++){
      const reply=remote.waitForResponse(r=>new URL(r.url()).pathname==='/api/player/control');
      await touch('touchStart',controlBox.x+controlBox.width/2,controlBox.y+controlBox.height/2);
      await touch('touchMove',controlBox.x+controlBox.width/2+2,controlBox.y+controlBox.height/2+3);
      await touch('touchEnd');await reply;await remote.waitForFunction(()=>!state.playerControlPendingAction);
      assert.equal(commands.length,beforeTap+i+1,'small pointer jitter retains a single ordinary activation');
      assert.equal(await remote.evaluate(()=>state.playbackSheetOpen&&!playbackSheetGesture.active),true);
    }
    commands.splice(beforeTap);
    const beforeDrag=commands.length;
    await touch('touchStart',controlBox.x+controlBox.width/2,controlBox.y+controlBox.height/2);
    for(const dy of [16,60,130,220]){await touch('touchMove',controlBox.x+controlBox.width/2,controlBox.y+controlBox.height/2+dy);await delay(25);}
    assert.equal(await remote.evaluate(()=>playbackSheetGesture.active),true,'vertical intent can start on an ordinary button');
    await screen('button-drag-active');await touch('touchEnd');await idle();
    assert.equal(commands.length,beforeDrag,'releasing a claimed button gesture must not play/pause');
    // This short movement straddles slide's halfway point; its velocity may
    // settle either way. A top-row button permits a position-based close that
    // is independent of dispatch speed on a loaded browser runner.
    if(await remote.evaluate(()=>state.playbackSheetOpen))await closeByClick();
    await openByClick();
    const ratingBox=await remote.locator('#open-rating-button').boundingBox();assert.ok(ratingBox);
    const distance=await remote.evaluate(()=>.65*(innerHeight-document.querySelector('#playback-sheet-panel').getBoundingClientRect().top));
    const ratingX=ratingBox.x+ratingBox.width/2,ratingY=ratingBox.y+ratingBox.height/2;
    assert.ok(ratingY+distance<700,'the deliberate close stays within the touch viewport');
    await touch('touchStart',ratingX,ratingY);
    for(const fraction of [.1,.3,.6,1]){await touch('touchMove',ratingX,ratingY+distance*fraction);await delay(25);}
    await screen('button-swipe-closing');await touch('touchEnd');await idle();await sheet.waitFor({state:'hidden'});
    assert.equal(await remote.locator('.rating-modal').count(),0,'the claimed release cannot open a rating dialog');
    await openByClick();
    for(const id of ['current-requester','current-meta','current-cache-state'])assert.equal(await remote.locator(`#${id}`).evaluate(n=>getComputedStyle(n).userSelect),'none');
    const prose=await remote.locator('#current-requester').boundingBox();
    await touch('touchStart',prose.x+prose.width/2,prose.y+prose.height/2);await delay(550);await touch('touchEnd');
    assert.equal(await remote.evaluate(()=>String(getSelection())),'','holding playback metadata cannot select text');
    const field=await remote.locator('#remote-av-offset-input').boundingBox();
    await touch('touchStart',field.x+field.width/2,field.y+field.height/2);
    await touch('touchMove',field.x+field.width/2,field.y+field.height/2+120);await touch('touchEnd');
    assert.equal(await remote.evaluate(()=>playbackSheetGesture.active),false,'Inputs retain their own gestures');
    assert.equal(await remote.evaluate(()=>state.playbackSheetOpen),true);await closeByClick();
    // Short content viewport: the entire overflowing body retains native scroll.
    await remote.setViewportSize({width:640,height:320});await openByClick();await idle();
    assert.equal(await body.evaluate(node=>node.scrollHeight>node.clientHeight+1),true);
    base=await body.boundingBox();baseX=base.x+3;baseY=base.y+Math.min(200,base.height-20);
    await touch('touchStart',baseX,baseY);
    for(const dy of [20,60,100,150]){await touch('touchMove',baseX,baseY-dy);await delay(30);}
    await touch('touchEnd');await delay(150);
    assert.ok(await body.evaluate(node=>node.scrollTop)>0,'Actual browser scroll wins over closing');
    assert.equal(await remote.evaluate(()=>state.playbackSheetOpen&&!playbackSheetGesture.active),true);
    await screen('short-body-scroll-priority');await closeByClick();
    await remote.setViewportSize({width:375,height:812});
    // Preserve the rendered input node across presentation only.
    await openByClick();
    const input=remote.locator('#remote-av-offset-input');
    const inputHandle=await input.elementHandle();
    await closeByClick();
    let box=await dock.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
    await touch('touchStart',x,y);
    for(const dy of [12,30,60,100,160,230]) {
      await touch('touchMove',x,y-dy);await delay(35);
      if(dy===12&&variant==='morph') {
        const initial=await remote.evaluate(()=>({body:parseFloat(getComputedStyle(document.querySelector('.playback-sheet-body')).opacity),handle:parseFloat(getComputedStyle(document.querySelector('#playback-sheet-collapse')).opacity)}));
        assert.equal(initial.body,0);assert.equal(initial.handle,0,'Drag bar stays hidden while dock content is shown');
      }
    }
    assert.equal(await remote.evaluate(()=>playbackSheetGesture.active),true);
    await screen('opening-half');
    assert.equal(await remote.evaluate(()=>document.querySelector('#playback-sheet').classList.contains('is-dragging')),true);
    const handleFade=await remote.evaluate(()=>({body:parseFloat(getComputedStyle(document.querySelector('.playback-sheet-body')).opacity),handle:parseFloat(getComputedStyle(document.querySelector('#playback-sheet-collapse')).opacity)}));
    assert.ok(Math.abs(handleFade.body-handleFade.handle)<.001,'Drag handle follows the content crossfade');
    const half=await sheet.locator('.playback-sheet-backdrop').evaluate(node=>parseFloat(getComputedStyle(node).opacity));
    assert.ok(half>0&&half<1,`Intermediate progress ${half}`);
    const first=geometry.at(-1);
    if(variant==='morph') {
      assert.ok(first.panel.width>box.width,'Surface expands horizontally');
      assert.ok(first.panel.height>box.height,'Surface expands vertically');
    }
    for(const dy of [300,380,450,520]) {await touch('touchMove',x,Math.max(15,y-dy));await delay(30);}
    await touch('touchEnd');await idle();await delay(50);
    assert.equal(await remote.evaluate(()=>state.playbackSheetOpen),true);await screen('opened');
    assert.equal(await inputHandle.evaluate(node=>node===document.querySelector('#remote-av-offset-input')),true);
    // Long press on the header selects no text; a tap still closes it.
    box=await header.boundingBox();x=box.x+25;y=box.y+box.height/2;
    await touch('touchStart',x,y);await delay(750);await touch('touchEnd');
    assert.equal(await remote.evaluate(()=>String(getSelection())), '');
    // A short, slow down-drag rebounds. Scrollable content keeps its gesture.
    await touch('touchStart',x,y);
    for(const dy of [12,28,45]) {await touch('touchMove',x,y+dy);await delay(75);}
    await delay(130);await touch('touchEnd');await idle();
    assert.equal(await remote.evaluate(()=>state.playbackSheetOpen),true);
    // Downwards motion follows the header until the same midpoint and closes.
    box=await header.boundingBox();x=box.x+25;y=box.y+box.height/2;
    await touch('touchStart',x,y);
    for(const dy of [15,50,100,160,230]) {await touch('touchMove',x,y+dy);await delay(40);}
    await screen('closing-half');
    for(const dy of [300,400,510,600]) {await touch('touchMove',x,Math.min(790,y+dy));await delay(30);}
    await touch('touchEnd');await idle();await sheet.waitFor({state:'hidden'});
    assert.equal(await remote.evaluate(()=>document.querySelector('.remote-shell').inert),false);
    // Cancellation rolls back to the original endpoint and leaves no capture/ghost.
    box=await dock.boundingBox();x=box.x+box.width/2;y=box.y+box.height/2;
    await touch('touchStart',x,y);await touch('touchMove',x,y-100);await touch('touchCancel');await idle();await sheet.waitFor({state:'hidden'});
    assert.equal(await remote.locator('.playback-sheet-dock-ghost').count(),0);
    // Short opening must close; horizontal dragging must retain document gestures.
    await touch('touchStart',x,y);await touch('touchMove',x,y-25);await delay(150);await touch('touchEnd');await idle();await sheet.waitFor({state:'hidden'});
    await touch('touchStart',x,y);await touch('touchMove',x+70,y-4);await touch('touchCancel');
    assert.equal(await remote.evaluate(()=>state.playbackSheetOpen),false);
    // Real quick flicks decide by recent velocity, before passing halfway.
    await touch('touchStart',x,y);
    await touch('touchMove',x,y-12);await delay(20);await touch('touchMove',x,y-130);await touch('touchEnd');
    await idle();assert.equal(await remote.evaluate(()=>state.playbackSheetOpen),true,'Upward flick expands');
    box=await header.boundingBox();x=box.x+25;y=box.y+box.height/2;
    await touch('touchStart',x,y);
    await touch('touchMove',x,y+12);await delay(20);await touch('touchMove',x,y+140);await touch('touchEnd');
    await idle();await sheet.waitFor({state:'hidden'});
    // Reverse direction shortly before release: use recent movement, not the
    // full gesture average or a previous animation's velocity.
    box=await dock.boundingBox();x=box.x+box.width/2;y=box.y+box.height/2;
    await touch('touchStart',x,y);
    for(const dy of [12,120,300,400]) {await touch('touchMove',x,y-dy);await delay(35);}
    await delay(140);
    await touch('touchMove',x,y-380);await delay(20);await touch('touchMove',x,y-260);await touch('touchEnd');
    await idle();await sheet.waitFor({state:'hidden'});
    for(const [width,height] of [[320,640],[360,640],[360,1000],[812,375]]) {
      await remote.setViewportSize({width,height});await openByClick();
      await remote.waitForFunction(()=>!state.playbackMetadataLayoutFrame);
      const hit=await collapse.evaluate(node=>{
        const rect=node.getBoundingClientRect(),points=[rect.left+22,rect.right-22];
        return {width:rect.width,blankTargets:points.map(x=>node.contains(document.elementFromPoint(x,rect.top+22))),
          actions:[...document.querySelectorAll('.playback-sheet-status-actions button')].map(button=>{
            const b=button.getBoundingClientRect();return button.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2));
          })};
      });
      assert.equal(hit.width,132,'Transparent handle target expands equally on both sides');
      assert.ok(hit.actions.every(Boolean),'Rating and refresh retain their own targets');
      assert.ok(hit.blankTargets.some(Boolean),'At least one extended blank area is usable');
      await screen(`opened-${width}x${height}`);await closeByClick();
    }
    await remote.setViewportSize({width:375,height:812});await remote.emulateMedia({reducedMotion:'reduce'});
    await openByClick();box=await header.boundingBox();x=box.x+20;y=box.y+box.height/2;
    await touch('touchStart',x,y);await touch('touchMove',x,y+60);
    await remote.setViewportSize({width:360,height:800});await idle();
    assert.equal(await remote.evaluate(()=>state.playbackSheetOpen),true);await touch('touchCancel');await closeByClick();
    await cdp.detach();
    assert.deepEqual(commands,[],'Hints and gestures never invoke playback commands');
    // Receipt survives a document reload; landscape does not redisplay it.
    await remote.reload();await dock.waitFor({state:'visible'});
    await remote.locator('#remote-identity-modal').waitFor({state:'hidden'});
    await openByClick();await delay(950);assert.equal(await menu.isVisible(),false);await closeByClick();
    // A real Restart traverses the existing native FIFO and decoder, then
    // renders one dedicated playback notice on the actual fullscreen surface.
    phase='confirmed-restart';
    await player.locator('#player-fullscreen-button').click();
    await player.waitForFunction(()=>document.fullscreenElement===elements.playerPanel);
    await remote.setViewportSize({width:812,height:375});await openByClick();
    await remote.locator('.playback-song-actions > .playback-restart-action').tap();
    await player.waitForFunction(()=>document.querySelector('#presentation-feedback [data-feedback-category="playback"].is-visible .presentation-feedback-label')?.textContent==='重唱');
    assert.equal(await player.locator('#presentation-feedback [data-feedback-category="playback"]').count(),1);
    assert.deepEqual(commands.slice(-2).map(command=>command.action),['seek-absolute','play']);
    assert.equal(commands.at(-2).target_seconds,0);
    assert.ok(await player.locator('#player-frame video').evaluate(video=>video.currentTime<3&&!video.paused));
    await player.screenshot({path:path.join(evidence,'fullscreen-restart-feedback.png')});
    await remote.screenshot({path:path.join(evidence,'remote-restart-completed.png')});await closeByClick();
    // Existing Next remains deliberate and usable during the passive preview.
    const nextPage=await hintContext.newPage(),explicitCommands=[];
    nextPage.on('pageerror',error=>errors.push(error.message));
    nextPage.on('request',request=>{if(['/api/player/control','/api/player/next'].includes(new URL(request.url()).pathname))explicitCommands.push(new URL(request.url()).pathname);});
    await nextPage.goto(host.base+'/remote');
    await nextPage.locator('#remote-identity-modal').waitFor({state:'hidden'});
    await nextPage.locator('#playback-dock').tap();
    await nextPage.waitForFunction(()=>document.querySelector('.playback-restart-popover').classList.contains('is-hint-open'));
    const original=await nextPage.evaluate(()=>state.data.current_item.id);
    await nextPage.locator('[data-control-action="next-track"]').tap();
    await nextPage.waitForFunction(id=>state.data.current_item.id!==id,original);
    assert.deepEqual(explicitCommands,['/api/player/next']);await hintContext.close();
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    assert.ok(httpFailures.every(f=>f.path==='/api/remote/connection-diagnostic'&&f.status===403&&f.beforeIdentity),JSON.stringify(httpFailures));
    assert.ok(warnings.every(w=>w==='Failed to load resource: the server responded with a status of 403 (Forbidden)'),JSON.stringify(warnings));
    writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,variant,geometry,commands,explicitCommands,errors,external,warnings,httpFailures},null,2)+'\n','utf8');passed=true;
  } catch(error) {
    writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({phase,error:String(error.stack),errors,external,commands,httpFailures,geometry},null,2)+'\n','utf8');
    for (const [i,page] of (browser?.contexts().flatMap(c=>c.pages())||[]).entries())try{await page.screenshot({path:path.join(evidence,`failure-${i}.png`)});}catch{}
    throw error;
  } finally {await browser?.close();await host?.close();if(passed)rmSync(home,{recursive:true,force:true});}
});
