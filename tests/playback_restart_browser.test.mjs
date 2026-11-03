// Actual native Host, media decoder and LAN Remote; no production services.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';

for (const layout of ['portrait','landscape']) test(`real Remote ${layout} restart, geometry and stale ownership`, {
  skip:process.platform!=='linux' && 'Linux native/browser fixture; native device acceptance is separate', timeout:120000,
},async()=>{
  const evidence=path.join(process.env.BILIKARA_RESTART_SCREENSHOTS || mkdtempSync(path.join(tmpdir(),'bilikara-restart-')),layout);
  mkdirSync(evidence,{recursive:true});
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-restart-host-'));
  let browser,host,passed=false,identityReady=false;
  const mediaGate=Promise.withResolvers();let waitingForMedia=true;
  const errors=[],warnings=[],commands=[],nextCommands=[],hostCommands=[],external=[],httpFailures=[];
  const pendingStatus=new Set();
  let phase='setup';
  try {
    const video=path.join(home,'video.mp4'), audio=path.join(home,'audio.m4a');
    for(const [file,args] of [[video,['-f','lavfi','-i','color=c=0x224466:s=640x360:r=10:d=90','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p']],
      [audio,['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=90','-af','volume=0.01','-c:a','aac']]]) {
      const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,file],process.env,30000);
      assert.equal(result.status,0,result.stderr);
    }
    const assets=path.join(root,'static');
    host=await RunningHost.start(process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha(),home,
      [home,assets,video,audio,'3'],isolatedEnvironment(home),true);
    browser=await chromium.launch({headless:process.env.BILIKARA_RESTART_HEADED!=='1',args:['--autoplay-policy=no-user-gesture-required']});
    const hostContext=await browser.newContext({viewport:{width:1000,height:800}});
    await hostContext.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    const remoteContext=await browser.newContext({viewport:layout==='portrait'?{width:360,height:800}:{width:812,height:375},hasTouch:true,isMobile:true});
    for(const context of [hostContext,remoteContext]) {
      await context.addInitScript(()=>{
        localStorage.setItem('bilikara.update.automatic','false');
        localStorage.setItem('bilikara.ui.language','zh');
      });
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.origin===host.base) {
          if(context===hostContext&&url.pathname.startsWith('/media/')&&waitingForMedia) await mediaGate.promise;
          return route.continue();
        }
        external.push(new URL(route.request().url()).origin); return route.abort();
      });
    }
    const player=await hostContext.newPage(), remote=await remoteContext.newPage();
    for(const page of [player,remote]) {
      page.setDefaultTimeout(12000);
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',message=>{if(message.type()==='warning'||message.type()==='error') warnings.push(message.text());});
      page.on('response',response=>{if(response.status()>=400)httpFailures.push({path:new URL(response.url()).pathname,status:response.status(),beforeIdentity:!identityReady,phase});});
    }
    await player.goto(host.base,{waitUntil:'domcontentloaded'});
    player.on('request',request=>{if(new URL(request.url()).pathname==='/api/player/control') hostCommands.push(request.postDataJSON());});
    player.on('request',request=>{if(new URL(request.url()).pathname==='/api/player/status') pendingStatus.add(request);});
    player.on('requestfinished',request=>pendingStatus.delete(request));
    player.on('requestfailed',request=>pendingStatus.delete(request));
    await remote.goto(host.base+'/remote');
    await remote.waitForFunction(()=>state.data?.session_user_entries?.length>0);
    await remote.locator('#remote-identity-input').fill('Restart fixture');
    await remote.locator('#remote-identity-submit').click();
    await remote.locator('#remote-identity-modal').waitFor({state:'hidden'});
    identityReady=true;
    await remote.locator('#playback-dock').click();
    await remote.locator('#playback-sheet').waitFor({state:'visible'});
    await remote.waitForFunction(()=>!playbackSheetGesture?.active);
    await remote.locator('.playback-sheet-panel').evaluate(node=>Promise.allSettled(node.getAnimations().map(animation=>animation.finished)));
    const iconSource=remote.locator('[data-control-action="seek-relative"][data-delta="-15"]');
    const anchor=remote.locator('[data-control-action="next-track"]');
    const menu=remote.locator('.playback-restart-popover');
    const trigger=remote.locator('.playback-song-actions > .playback-restart-action');
    remote.on('request',request=>{
      const pathname=new URL(request.url()).pathname;
      if(pathname==='/api/player/control') commands.push(request.postDataJSON());
      if(pathname==='/api/player/next') nextCommands.push(request.postDataJSON());
    });
    assert.equal(await trigger.isDisabled(),true,'Cached URLs before Host media readiness cannot enable Restart');
    assert.equal(await remote.evaluate(()=>state.data.player_status),null);
    if(layout==='portrait') {
      await anchor.click({button:'right'});
      await menu.waitFor({state:'visible'});
      assert.equal(await menu.locator('button').isDisabled(),true,'Opening the capsule does not enable an unavailable Restart');
      await remote.keyboard.press('Escape');
      await menu.waitFor({state:'hidden'});
      const before=commands.length,beforeNext=nextCommands.length;
      const held=await hold({release:false});
      assert.equal(await menu.locator('button').isDisabled(),true,'A real held touch can reveal a disabled Restart');
      await host.api('/api/session-users/add',{name:'Pending playback'});
      await remote.waitForFunction(()=>state.data.session_users.includes('Pending playback'));
      assert.equal(await menu.isVisible(),true,'An actual SSE refresh retains the open capsule while media is unavailable');
      const target=await menu.locator('button').boundingBox();
      await held.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:target.x+target.width/2,y:target.y+target.height/2}]});
      assert.equal(await menu.locator('button').evaluate(node=>node.classList.contains('is-held-target')),false,'A disabled Restart cannot be armed');
      await held.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await held.detach();
      assert.equal(commands.length,before,'Releasing over a disabled Restart submits no command');
      assert.equal(nextCommands.length,beforeNext,'Holding Next does not accidentally skip');
      await remote.screenshot({path:path.join(evidence,'remote-unavailable-restart-capsule.png')});
      await remote.keyboard.press('Escape');
      await menu.waitFor({state:'hidden'});
    } else {
      const before=commands.length;
      await trigger.tap({force:true});assert.equal(commands.length,before,'Disabled Restart sends no command');
    }
    waitingForMedia=false;mediaGate.resolve();
    await player.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted);
    await player.waitForFunction(()=>{const video=document.querySelector('#player-frame video');return video && !video.paused && video.currentTime>0;});
    await remote.waitForFunction(()=>state.data.player_status?.observed_phase==='playing');
    await anchor.waitFor();
    await remote.waitForFunction(()=>!document.querySelector('[data-control-action="next-track"]').disabled);
    const progress=remote.locator('#playback-sheet-seek');
    async function seekToMiddle() {
      await remote.waitForFunction(()=>!document.querySelector('#playback-sheet-seek').disabled);
      const box=await progress.boundingBox();
      if(!await progress.evaluate(node=>node.classList.contains('is-engaged'))) {
        const before=commands.length;
        await progress.click({position:{x:box.width*.1,y:box.height/2}});
        assert.equal(commands.length,before,'The first gesture only reveals the seek thumb');
      }
      await remote.mouse.move(box.x+box.width*.1,box.y+box.height/2);
      await remote.mouse.down();
      await remote.mouse.move(box.x+box.width*.45,box.y+box.height/2,{steps:3});
      await remote.mouse.up();
      await player.waitForFunction(()=>document.querySelector('#player-frame video').currentTime>25);
      await remote.waitForFunction(()=>!state.playerControlPendingAction);
    }
    async function hold({release=true}={}) {
      await anchor.scrollIntoViewIfNeeded();
      const box=await anchor.boundingBox(),session=await remoteContext.newCDPSession(remote);
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
      await remote.waitForFunction(()=>document.querySelector('.playback-restart-popover')?.classList.contains('is-open'));
      if(release) {
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await session.detach();
      }
      await menu.evaluate(node=>Promise.allSettled(node.getAnimations({subtree:true}).map(animation=>animation.finished)));
      return session;
    }
    async function openChoice() {
      if(layout==='portrait') await hold();
      else await trigger.waitFor({state:'visible'});
    }
    async function pauseAndSettle() {
      await player.waitForFunction(()=>state.hostPlaybackSession?.phase==='playing');
      const item=await player.evaluate(()=>state.data.current_item.id);
      if(!await player.locator('#player-frame video').evaluate(video=>video.paused)) {
        const acknowledged=player.waitForResponse(response=>new URL(response.url()).pathname==='/api/player/status'
          &&response.status()===200&&response.request().postDataJSON()?.item_id===item&&response.request().postDataJSON()?.is_paused===true);
        await remote.locator('[data-control-action="toggle-play"]').tap();
        await player.waitForFunction(()=>document.querySelector('#player-frame video').paused);
        await acknowledged;
        await remote.waitForFunction(()=>!state.playerControlPendingAction);
      }
      // Complete actual decoder acknowledgements before the fixture changes
      // songs; do not create incidental status races around the stale-menu case.
      await Promise.all([...pendingStatus].map(async request=>(await request.response())?.finished()));
    }
    assert.equal(await remote.title(),'bilikara remote');
    assert.equal(new URL(remote.url()).pathname,'/remote');
    assert.ok((await remote.locator('body').innerText()).includes('Native Alpha fixture 1'));
    phase='held-control-hints';
    const bubble=remote.locator('.playback-control-hint'),hintChecks=[];
    const hintStyle=node=>{const s=getComputedStyle(node);return Object.fromEntries(['fontSize','fontWeight','lineHeight','borderRadius','padding','backgroundColor','color','boxShadow','backdropFilter','transitionDuration'].map(key=>[key,s[key]]));};
    // A real existing i button supplies the reference surface in this theme.
    await remote.locator('[aria-describedby="remote-volume-info"]').tap();
    const referenceStyle=await remote.locator('#remote-volume-info').evaluate(hintStyle);
    await remote.locator('[aria-describedby="remote-volume-info"]').tap();
    await iconSource.hover();await delay(600);
    assert.equal(await bubble.isVisible(),false,'Remote pointer hover never opens the held hint');
    const infoSession=await remoteContext.newCDPSession(remote);
    const infoTouch=(type,box)=>infoSession.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
    const expectHint=async(button,name)=>{
      await remote.waitForFunction(copy=>{
        const tip=document.querySelector('.playback-control-hint');return tip.classList.contains('is-visible') && tip.textContent===copy;
      },name);
      assert.equal(await bubble.evaluate(hintStyle).then(style=>JSON.stringify(style)),JSON.stringify(referenceStyle),'Held hints reuse the actual i bubble surface and motion');
      assert.ok((await button.getAttribute('aria-describedby')).includes(await bubble.getAttribute('id')));
      const box=await bubble.boundingBox(),size=await remote.viewportSize();
      assert.ok(box.x>=8&&box.x+box.width<=size.width-8&&box.y>=8&&box.y+box.height<=size.height-8,`Actual hint stays within viewport: ${JSON.stringify({name,box,size})}`);
      await bubble.evaluate(node=>Promise.allSettled(node.getAnimations().map(animation=>animation.finished)));
      assert.equal(await bubble.evaluate(node=>getComputedStyle(node).opacity),'1','The settled annotation is actually visible');
      hintChecks.push({name,box});
    };
    const beforeHints=commands.length,beforeHintsNext=nextCommands.length;
    try {
      await infoTouch('touchStart',await iconSource.boundingBox());
      await expectHint(iconSource,await iconSource.getAttribute('aria-label'));
      await remote.screenshot({path:path.join(evidence,'held-back-hint.png')});
      const toggle=remote.locator('[data-control-action="toggle-play"]');
      await infoTouch('touchMove',await toggle.boundingBox());
      await expectHint(toggle,await toggle.getAttribute('aria-label'));
      assert.equal(await iconSource.getAttribute('aria-describedby'),null,'Sliding removes the old anchor association');
      await infoTouch('touchMove',{x:0,y:0,width:2,height:2});await bubble.waitFor({state:'hidden'});
      const forward=remote.locator('[data-control-action="seek-relative"][data-delta="15"]');
      await infoTouch('touchMove',await forward.boundingBox());
      await expectHint(forward,await forward.getAttribute('aria-label'));
      // Reopen during the exit transition; the old completion cannot hide it.
      await infoTouch('touchMove',{x:0,y:0,width:2,height:2});
      await infoTouch('touchMove',await toggle.boundingBox());await delay(180);
      await expectHint(toggle,await toggle.getAttribute('aria-label'));
      await remote.screenshot({path:path.join(evidence,'held-slide-play-hint.png')});
      await infoTouch('touchEnd');await bubble.waitFor({state:'hidden'});
      assert.equal(await toggle.getAttribute('aria-describedby'),null);
      if(layout==='portrait') {
        const held=await hold({release:false});
        await expectHint(anchor,'切歌；向左滑动可重唱');
        await remote.screenshot({path:path.join(evidence,'held-next-gesture-hint.png')});
        await held.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await held.detach();
        await bubble.waitFor({state:'hidden'});
        assert.equal(await menu.isVisible(),true,'Release closes only the hint and leaves the capsule usable');
        const restartButton=menu.locator('.playback-restart-action');
        await infoTouch('touchStart',await restartButton.boundingBox());
        await expectHint(restartButton,'重唱\n从头播放当前歌曲');
        await remote.screenshot({path:path.join(evidence,'held-restart-hint.png')});
        await infoTouch('touchEnd');await bubble.waitFor({state:'hidden'});
        await remote.locator('#playback-sheet-title').tap();await menu.waitFor({state:'hidden'});
      } else {
        await infoTouch('touchStart',await trigger.boundingBox());
        await expectHint(trigger,'重唱\n从头播放当前歌曲');
        await remote.screenshot({path:path.join(evidence,'held-restart-hint.png')});
        await infoTouch('touchMove',await anchor.boundingBox());await expectHint(anchor,'切歌');
        await infoTouch('touchCancel');await bubble.waitFor({state:'hidden'});
      }
    } finally {await infoTouch('touchCancel').catch(()=>{});await infoSession.detach();}
    await delay(180);
    assert.equal(commands.length,beforeHints,'Holding and sliding between ordinary hints invokes no playback command');
    assert.equal(nextCommands.length,beforeHintsNext,'Releasing a held explanation never skips');
    assert.equal(await remote.evaluate(()=>String(getSelection())),'');
    writeFileSync(path.join(evidence,'held-hints.json'),JSON.stringify({referenceStyle,hintChecks,commands:commands.length-beforeHints,next:nextCommands.length-beforeHintsNext},null,2)+'\n','utf8');
    if(layout==='portrait') {
      // Computed opacity cannot detect the masked-backdrop compositor bug.
      // Capture actual PNG compositor frames around a real open/close action.
      await verifyNextRaster(remote,remoteContext,anchor,evidence,async()=>{
        await anchor.click({button:'right'});
        await menu.waitFor({state:'visible'});await delay(250);
        await remote.locator('#playback-sheet-title').tap();
        await menu.waitFor({state:'hidden'});await delay(120);
        await hold();await delay(250);
        await remote.locator('#playback-sheet-title').tap();
        await menu.waitFor({state:'hidden'});await delay(120);
      });
      assert.equal(await anchor.evaluate(node=>getComputedStyle(node).webkitTapHighlightColor),'rgba(0, 0, 0, 0)','Captured holds use the existing pressed feedback without an extra native tap flash');
    }
    await seekToMiddle();
    const beforeShort=commands.length;
    await iconSource.tap();
    await player.waitForFunction(()=>document.querySelector('#player-frame video').currentTime<30);
    assert.equal(commands.length,beforeShort+1);
    assert.equal(commands.at(-1).action,'seek-relative'); assert.equal(commands.at(-1).delta_seconds,-15);
    const dimensions=[];
    for(const [width,height] of [[360,800],[320,800],[700,800],[360,640],[360,1000],[375,812],[812,375]]) {
      await remote.setViewportSize({width,height});
      await remote.waitForFunction(width=>innerWidth===width,width);
      await remote.waitForFunction(({width,height})=>{const v=JSON.parse(state.playbackMetadataLayoutSignature||'{}');return v.viewportWidth===width&&v.viewportHeight===height&&!state.playbackMetadataLayoutFrame;},{width,height});
      const portrait=height>=width,beforeHold=commands.length,beforeNext=nextCommands.length;
      const size=height===800?String(width):String(width)+'x'+String(height);
      await remote.screenshot({path:path.join(evidence,'remote-'+size+'-normal.png')});
      if(portrait && width===375 && height===812) {
        const held=await hold({release:false});
        await remote.waitForFunction(()=>document.querySelector('.playback-control-hint').classList.contains('is-visible'));
        await bubble.evaluate(node=>Promise.allSettled(node.getAnimations().map(animation=>animation.finished)));
        await remote.screenshot({path:path.join(evidence,'held-next-375x812.png')});
        await held.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await held.detach();
        await bubble.waitFor({state:'hidden'});
      } else if(portrait) await hold();
      else await trigger.waitFor({state:'visible'});
      assert.equal(commands.length,beforeHold,'Rendering or holding and releasing never mutates playback');
      assert.equal(nextCommands.length,beforeNext,'A long-press release must never skip the song');
      const bounds=await anchor.boundingBox();
      const capsule=portrait?menu:remote.locator('.playback-song-actions');
      const geometry=await capsule.evaluate(node=>{
        const buttons=node.matches('.playback-restart-popover')
          ? [node.querySelector('button'),node.parentElement.querySelector('[data-playback-restart-anchor]')]
          : [...node.querySelectorAll('button')].filter(button=>button.getClientRects().length);
        const r=node.getBoundingClientRect(),targets=buttons.map(button=>{
          const b=button.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};});
        const style=node.matches('.playback-restart-popover')?getComputedStyle(node,'::before'):getComputedStyle(node);
        return{x:r.x,y:r.y,width:r.width,height:r.height,targets,blur:style.backdropFilter,
          background:style.backgroundColor,shadow:style.boxShadow,
          radii:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius],
          bodyOverflow:document.documentElement.scrollWidth>innerWidth,textSelected:String(getSelection())};
      });
      assert.ok(geometry.x>=8 && geometry.x+geometry.width<=width-8);
      assert.ok(geometry.targets.every(target=>target.width===44 && target.height===44));
      const [left,right]=geometry.targets;
      if(portrait) {
        assert.equal(geometry.width,100); assert.equal(geometry.height,52);
        assert.ok(geometry.radii.every(radius=>parseFloat(radius)>=geometry.height/2),'Popup has complete semicircular ends');
        const margins=[left.x-geometry.x,geometry.x+geometry.width-right.x-right.width,
          left.y-geometry.y,geometry.y+geometry.height-left.y-left.height,right.x-left.x-left.width];
        assert.ok(margins.every(inset=>Math.abs(inset-4)<0.01),'Popup has equal four-pixel insets and inter-button gap');
        assert.notEqual(geometry.blur,'none');
      } else {
        assert.equal(geometry.width,94); assert.equal(geometry.height,44);
        assert.equal(right.x-left.x-left.width,6,'Ordinary exposed buttons have a six-pixel gap');
        assert.equal(geometry.blur,'none'); assert.equal(geometry.shadow,'none');
        assert.equal(geometry.background,'rgba(0, 0, 0, 0)','Exposed buttons have no enclosing capsule');
      }
      assert.ok(Math.abs(right.y-bounds.y)<1 && Math.abs(right.x-bounds.x)<1,'Right target stays over the original Next button');
      assert.equal(geometry.bodyOverflow,false); assert.equal(geometry.textSelected,'');
      assert.ok(geometry.y>=0 && geometry.y+geometry.height<=height,'Capsule fits viewport height');
      assert.equal(await remote.locator('.playback-restart-confirm').count(),0);
      if(portrait) {
        assert.equal(await anchor.evaluate(node=>getComputedStyle(node).opacity),'1','Original Next remains visible throughout capsule presentation');
        assert.equal(await remote.locator('.playback-restart-next').count(),0,'Next has no replacement glyph or click proxy');
        assert.equal(await anchor.evaluate(node=>{
          const r=node.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===node;
        }),true,'The original Next remains above the capsule and receives deliberate taps itself');
      }
      else {
        assert.equal(await menu.isVisible(),false,'Landscape exposes actions directly without opening a popup');
        assert.equal(await anchor.getAttribute('aria-haspopup'),null);
        const progress=await remote.locator('.player-progress-unit').boundingBox();
        assert.ok(progress.x+progress.width<=geometry.x||progress.y+progress.height<=geometry.y,'Inline capsule cannot overlap progress');
        const row=await remote.locator('.player-control-row').boundingBox();
        const layout=await remote.evaluate(()=>state.playbackMetadataLayoutEvidence);
        assert.equal(layout.transportLayout,'spacious','Left height alone permits a separate progress row');
        assert.ok(layout.secondaryNaturalHeight>layout.availablePrimaryHeight,'Real settings require scrolling while progress still gets its own row');
        assert.ok(Math.abs(progress.width-row.width)<1,'Progress spans the full left control row');
        assert.ok(progress.y+progress.height<=geometry.y,'Song actions sit below the full-width progress row');
      }
      const ringTarget=capsule.locator('.playback-restart-action:visible [data-restart-ring]');
      const border=node=>{const s=getComputedStyle(node);return [s.borderTopWidth,s.borderTopStyle,s.borderTopColor];};
      assert.deepEqual(await ringTarget.locator('..').locator('..').evaluate(border),await iconSource.evaluate(border),'Restart and -15s share the ordinary circle outline');
      const attributes=node=>Object.fromEntries(['d','transform','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin'].map(key=>[key,node.getAttribute(key)]));
      assert.deepEqual(await ringTarget.evaluate(attributes),await iconSource.locator('svg path').evaluate(attributes),'Restart reuses the exact existing -15s arrow geometry');
      const ring=await ringTarget.evaluate(node=>{const b=node.parentElement.getBBox();return {x:b.x+b.width/2,y:b.y+b.height/2};});
      const backRing=await iconSource.locator('svg').evaluate(node=>{const b=node.getBBox();return {x:b.x+b.width/2,y:b.y+b.height/2};});
      assert.ok(Math.abs(ring.x-backRing.x)<0.001 && Math.abs(ring.y-backRing.y)<0.001,'Both arrows retain the same optical center');
      dimensions.push({width,height,geometry,ring});
      await remote.screenshot({path:path.join(evidence,'remote-'+size+'-open.png')});
      await capsule.screenshot({path:path.join(evidence,'remote-'+size+'-detail.png')});
      if(portrait) {
        const frames=remote.evaluate(async()=>{
          const button=document.querySelector('[data-control-action="next-track"]'),samples=[];
          for(let i=0;i<16;i++) {
            await new Promise(resolve=>requestAnimationFrame(resolve));
            const rect=button.getBoundingClientRect(),style=getComputedStyle(button);
            samples.push({x:rect.x,y:rect.y,width:rect.width,height:rect.height,opacity:style.opacity,visibility:style.visibility,border:style.borderColor,background:style.backgroundColor});
          }
          return samples;
        });
        await remote.locator('#playback-sheet-title').tap();
        await menu.waitFor({state:'hidden'});
        const samples=await frames;
        assert.ok(samples.every(sample=>sample.opacity==='1'&&sample.visibility==='visible'),'Next never fades during capsule exit');
        assert.ok(samples.every(sample=>JSON.stringify(sample)===JSON.stringify(samples[0])),'Next geometry, fill and outline remain fixed at every exit frame');
        assert.equal(commands.length,beforeHold,'Outside dismissal never mutates playback');
        assert.equal(nextCommands.length,beforeNext,'Outside dismissal never skips');
      }
    }
    // A genuinely short landscape keeps compact controls. Merely being in
    // landscape must not force a second row beyond the left height budget.
    await remote.setViewportSize({width:812,height:240});
    await remote.waitForFunction(()=>JSON.parse(state.playbackMetadataLayoutSignature||'{}').viewportHeight===240&&!state.playbackMetadataLayoutFrame);
    const shortLayout=await remote.evaluate(()=>state.playbackMetadataLayoutEvidence);
    assert.equal(shortLayout.transportLayout,'compact');
    assert.ok(shortLayout.compactPrimaryNaturalHeight+shortLayout.spaciousExtraHeight+10>shortLayout.availablePrimaryHeight);
    await anchor.scrollIntoViewIfNeeded();
    await remote.screenshot({path:path.join(evidence,'remote-812x240-fallback.png')});
    await remote.setViewportSize(layout==='portrait'?{width:360,height:800}:{width:812,height:375});
    await remote.waitForFunction(portrait=>document.querySelector('.playback-song-actions').classList.contains('is-expanded')!==portrait,layout==='portrait');
    if(layout==='portrait') {
      // A cancelled drag cannot become a delayed short Next after suppression expires.
      await anchor.scrollIntoViewIfNeeded();
      const box=await anchor.boundingBox(),session=await remoteContext.newCDPSession(remote),before=commands.length;
      const item=(await host.api('/api/state')).current_item.id;
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+22,y:box.y+22}]});
      await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+36,y:box.y+22}]});
      await delay(1100);
      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await session.detach();
      assert.equal(commands.length,before);
      assert.equal((await host.api('/api/state')).current_item.id,item,'Cancelled hold never skips the song');
      assert.equal(await menu.isVisible(),false);
    }
    await seekToMiddle();
    const same=await host.api('/api/state'), media=await player.evaluate(()=>{
      window.restartMediaNodes=[...document.querySelectorAll('#player-frame video,#player-frame audio')];
      return {position:restartMediaNodes[0].currentTime};
    });
    assert.ok(media.position>25);
    await remote.locator('[data-control-action="toggle-play"]').tap();
    await player.waitForFunction(()=>document.querySelector('#player-frame video').paused);
    await remote.waitForFunction(()=>!state.playerControlPendingAction);
    const beforeRestart=commands.length;
    // Hold a real accepted seek response to exercise duplicate-tap guards.
    // Provider/media/command results are never fabricated.
    const seekSeen=Promise.withResolvers(),releaseSeek=Promise.withResolvers();
    if(layout==='landscape') await remote.route('**/api/player/control',async route=>{
      const response=await route.fetch();
      if(route.request().postDataJSON().action==='seek-absolute') {
        seekSeen.resolve();await releaseSeek.promise;
      }
      await route.fulfill({response});
    });
    try {
      await openChoice();
      if(layout==='portrait') await menu.locator('.playback-restart-action').tap();
      else {
        await trigger.tap();
        await seekSeen.promise;
        assert.equal(await trigger.getAttribute('aria-busy'),'true');
        assert.equal(await trigger.isDisabled(),true);
        await trigger.tap({force:true});
        assert.deepEqual(commands.slice(beforeRestart).map(command=>command.action),['seek-absolute'],'A second real tap while pending cannot submit another restart');
        assert.equal(await remote.locator('.playback-restart-confirm').count(),0);
        releaseSeek.resolve();
      }
      await player.waitForFunction(()=>{const video=document.querySelector('#player-frame video');return !video.paused && video.currentTime<5;});
      await remote.waitForFunction(()=>!state.playerControlPendingAction);
    } finally {
      releaseSeek.resolve();
      if(layout==='landscape') await remote.unroute('**/api/player/control');
    }
    assert.deepEqual(commands.slice(beforeRestart).map(command=>command.action),['seek-absolute','play']);
    assert.ok(commands.slice(beforeRestart).every(command=>command.item_id===same.current_item.id&&command.playback_generation===same.playback_generation));
    const after=await host.api('/api/state');
    assert.equal(after.current_item.item_incarnation_id,same.current_item.item_incarnation_id);
    assert.deepEqual(after.playlist,same.playlist);
    assert.deepEqual(after.song_ratings,same.song_ratings);
    assert.deepEqual(after.player_settings,same.player_settings);
    assert.equal(await player.evaluate(()=>restartMediaNodes.every((node,index)=>node===[...document.querySelectorAll('#player-frame video,#player-frame audio')][index])),true);
    await remote.screenshot({path:path.join(evidence,'remote-360-restarted.png')});
    if(layout==='portrait') {
      // Moving back out or cancelling after arming must not submit either command.
      for(const cancelled of [false,true]) {
        const before=commands.length,beforeNext=nextCommands.length,session=await hold({release:false});
        const target=await menu.locator('.playback-restart-action').boundingBox();
        await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:target.x+22,y:target.y+22}]});
        await remote.waitForFunction(()=>document.querySelector('.playback-restart-action.is-held-target'));
        if(cancelled) await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
        else {
          const next=await anchor.boundingBox();
          await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:next.x+22,y:next.y+22}]});
          assert.equal(await menu.locator('.is-held-target').count(),0);
          await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
          await remote.locator('#playback-sheet-title').tap();
        }
        await session.detach();await menu.waitFor({state:'hidden'});
        assert.equal(commands.length,before);assert.equal(nextCommands.length,beforeNext);
      }
      // Entering Restart arms pressed feedback; only releasing there submits.
      await seekToMiddle();
      const beforeDrag=commands.length,beforeDragNext=nextCommands.length;
      const session=await hold({release:false});
      let released=false;
      try {
        const target=await menu.locator('.playback-restart-action').boundingBox();
        await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:target.x+22,y:target.y+22}]});
        await remote.waitForFunction(()=>document.querySelector('.playback-restart-action.is-held-target'));
        await delay(150);
        assert.equal(commands.length,beforeDrag,'Moving over Restart sends no mutation');
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        released=true;
        await player.waitForFunction(()=>{const v=document.querySelector('#player-frame video');return !v.paused&&v.currentTime<5;});
        await remote.waitForFunction(()=>!state.playerControlPendingAction);
        assert.deepEqual(commands.slice(beforeDrag).map(command=>command.action),['seek-absolute','play'],'Release submits one ordered restart');
        assert.equal(await menu.isVisible(),false);
        await remote.screenshot({path:path.join(evidence,'remote-drag-restarted.png')});
      } finally {
        if(!released) await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
        await session.detach();
      }
      await delay(200);
      assert.equal(nextCommands.length,beforeDragNext,'Releasing after drag cannot activate Next');
      assert.deepEqual(commands.slice(beforeDrag).map(command=>command.action),['seek-absolute','play'],'Drag release never resubmits the mutation');

      // Tapping the capsule's unused inset dismisses it without seeking through.
      await hold();
      const box=await menu.boundingBox(),beforeGap=commands.length;
      await remote.touchscreen.tap(box.x+2,box.y+box.height/2);await menu.waitFor({state:'hidden'});
      await delay(200);assert.equal(commands.length,beforeGap);assert.equal(nextCommands.length,beforeDragNext);
      // Keyboard opens the capsule; Escape cancels without closing the sheet.
      await anchor.focus();await remote.keyboard.press('ArrowLeft');await menu.waitFor({state:'visible'});
      assert.equal(await menu.locator('.playback-restart-action').evaluate(node=>node===document.activeElement),true);
      await remote.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
      assert.equal(await anchor.evaluate(node=>node===document.activeElement),true);
      assert.equal(await remote.locator('#playback-sheet').isVisible(),true);
      await anchor.click({button:'right'}); await menu.waitFor({state:'visible'});
      await remote.keyboard.press('Escape'); await menu.waitFor({state:'hidden'});
    } else {
      const beforeKeyboard=commands.length;
      await trigger.focus();await remote.keyboard.press('Enter');
      await remote.waitForFunction(()=>!state.playerControlPendingAction);
      assert.deepEqual(commands.slice(beforeKeyboard).map(command=>command.action),['seek-absolute','play']);
      assert.equal(await remote.locator('#playback-sheet').isVisible(),true);
    }
    phase='stale-restart';
    if(layout==='portrait') {
      await pauseAndSettle();
      await hold();const beforeSwitch=commands.length;
      await host.api('/api/player/next',{playback_generation:(await host.api('/api/state')).playback_generation});
      await remote.waitForFunction(()=>state.data?.current_item?.id==='fixture-second');
      await menu.waitFor({state:'hidden'});
      assert.equal(commands.length,beforeSwitch,'Dismissed stale menu cannot restart the new song');
    } else {
      // An old accepted response must not submit play after another device skips.
      await seekToMiddle();
      await remote.locator('[data-control-action="toggle-play"]').tap();
      await player.waitForFunction(()=>document.querySelector('#player-frame video').paused);
      await remote.waitForFunction(()=>!state.playerControlPendingAction);
      // Settle the real decoder's status acknowledgement before skipping; the
      // response under test remains held, without introducing a status race.
      const settledStatus=player.waitForResponse(response=>new URL(response.url()).pathname==='/api/player/status'
        &&response.status()===200&&response.request().postDataJSON()?.current_time<2);
      const accepted=Promise.withResolvers(),release=Promise.withResolvers(),beforeSwitch=commands.length;
      await remote.route('**/api/player/control',async route=>{
        const response=await route.fetch();accepted.resolve();await release.promise;await route.fulfill({response});
      });
      try {
        await trigger.tap();await accepted.promise;await settledStatus;
        await Promise.all([...pendingStatus].map(async request=>(await request.response())?.finished()));
        await host.api('/api/player/next',{playback_generation:(await host.api('/api/state')).playback_generation});
        await remote.waitForFunction(()=>state.data?.current_item?.id==='fixture-second');
        release.resolve();await remote.waitForFunction(()=>!state.playerControlPendingAction);
        assert.deepEqual(commands.slice(beforeSwitch).map(command=>command.action),['seek-absolute']);
        assert.equal((await host.api('/api/state')).current_item.id,'fixture-second');
      } finally {release.resolve();await remote.unroute('**/api/player/control');}
    }
    // Short Next retains its original action, also while the capsule is open.
    await player.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted&&state.data?.current_item?.id==='fixture-second');
    phase='short-next';
    await pauseAndSettle();
    const beforeNext=nextCommands.length;
    await anchor.tap();
    await remote.waitForFunction(()=>state.data?.current_item?.id==='fixture-third'&&!state.playerControlPendingAction);
    assert.equal(nextCommands.length,beforeNext+1,'Short Next submits exactly one original command');
    if(layout==='portrait') {
      await player.waitForFunction(()=>state.hostPlaybackSession?.readyCommitted&&state.data?.current_item?.id==='fixture-third');
      phase='menu-next';
      await pauseAndSettle();
      await hold();
      await anchor.tap();
      await remote.waitForFunction(()=>!state.data?.current_item&&!state.playerControlPendingAction);
      assert.equal(nextCommands.length,beforeNext+2,'A fresh tap on the original Next with its capsule open submits exactly once');
    }
    assert.deepEqual(external,[]); assert.deepEqual(errors,[]);
    // Diagnostics and rating lookup can run during the intentional initial
    // media hold, before identity/eligible playback. Retain those exact refusals.
    assert.ok(httpFailures.every(failure=>['/api/remote/connection-diagnostic','/api/rating/log'].includes(failure.path)
      &&failure.status===403&&failure.beforeIdentity&&failure.phase==='setup'),JSON.stringify(httpFailures));
    assert.equal(warnings.length,httpFailures.length);
    assert.ok(warnings.every(warning=>warning==='Failed to load resource: the server responded with a status of 403 (Forbidden)'));
    writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,layout,dimensions,commands,nextCommands,hostCommands,errors,warnings,httpFailures,external,flow:'actual native Host + LAN Remote; real decoder and touch/keyboard actions; no Worker'},null,2)+'\n','utf8');
    console.log(`Restart screenshots: ${evidence}`); passed=true;
  } catch(error) {
    writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:String(error.stack),commands,hostCommands,errors,warnings,httpFailures,external},null,2)+'\n','utf8');
    for(const [index,page] of (browser?.contexts().flatMap(context=>context.pages())||[]).entries()) {
      try{await page.screenshot({path:path.join(evidence,`failure-${index}.png`)});}catch{}
    }
    console.error(`Failure evidence retained: ${evidence}`); throw error;
  } finally {
    mediaGate.resolve();
    await browser?.close(); await host?.close();
    if(passed) rmSync(home,{recursive:true,force:true});
  }
});

test('rendered Host restart component keeps disabled hover quiet and shares accessible help', {timeout:30000}, async t=>{
  // Production markup/styles/component with controlled presentation inputs.
  // This is UI coverage, separate from real native Runtime/decoder tests above.
  const html=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');
  const fragment=html.match(/<section class="presentation-host-controls"[\s\S]*?<\/section>/u)[0].replace(' hidden','');
  const css=['styles.css','ui-surfaces.css'].map(file=>readFileSync(new URL('../static/'+file,import.meta.url),'utf8')).join('\n');
  const labels=JSON.parse(readFileSync(new URL('../static/i18n.json',import.meta.url),'utf8')).languages.zh;
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:700,height:600}});
  await context.route('**/*',route=>route.abort());
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<title>bilikara Host playback component fixture</title><style>${css}</style><body class="is-presentation-control-host"><main class="app-shell">${fragment}</main></body>`);
  await page.addScriptTag({path:path.join(root,'static/playback-restart.js')});
  await page.evaluate(labels=>{
    window.fixtureContext={itemId:'fixture',generation:1,key:'fixture:1',enabled:false};window.fixtureActivations=[];
    window.fixtureRestart=BilikaraPlaybackRestart.create({anchor:document.querySelector('#presentation-host-next'),iconSource:document.querySelector('#presentation-host-back'),
      getContext:()=>fixtureContext,label:key=>labels[key],alwaysInline:true,hoverHints:true,onRestart:async context=>fixtureActivations.push(context.key)});
  },labels);
  const action=page.locator('.playback-song-actions > .playback-restart-action'),bubble=page.locator('.playback-control-hint');
  const appearance=node=>{const s=getComputedStyle(node);return {border:s.borderColor,background:s.backgroundColor,color:s.color,opacity:s.opacity};};
  for(const theme of ['light','dark','blue']) {
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;fixtureContext.enabled=false;fixtureRestart.refresh();},theme);
    await page.mouse.move(1,1);await delay(200);
    const quiet=await action.evaluate(appearance);
    await action.hover();await delay(350);
    assert.deepEqual(await action.evaluate(appearance),quiet,'Disabled controls retain the same fill/outline on hover');
    assert.equal(await bubble.isVisible(),false);assert.equal(await action.isDisabled(),true);
    await action.click({force:true});assert.deepEqual(await page.evaluate(()=>fixtureActivations),[]);
    await page.mouse.move(1,1);
    await page.evaluate(()=>{fixtureContext.enabled=true;fixtureRestart.refresh();});
    await action.hover();await bubble.waitFor({state:'visible'});
    assert.equal(await bubble.textContent(),labels['player.restart']+'\n'+labels['player.restartDescription']);
    assert.deepEqual(await bubble.evaluate(node=>{const s=getComputedStyle(node);return [s.fontSize,s.fontWeight,s.borderRadius];}),['13px','400','12px']);
    await page.mouse.move(1,1);await bubble.waitFor({state:'hidden'});
  }
  await page.keyboard.press('Tab');await action.focus();await bubble.waitFor({state:'visible'});
  await bubble.evaluate(node=>Promise.allSettled(node.getAnimations().map(animation=>animation.finished)));
  assert.ok((await action.getAttribute('aria-describedby')).includes(await bubble.getAttribute('id')));
  if(process.env.BILIKARA_RESTART_SCREENSHOTS) {
    const hint=await bubble.boundingBox(),row=await page.locator('.presentation-host-transport-row').boundingBox();
    await page.screenshot({path:path.join(process.env.BILIKARA_RESTART_SCREENSHOTS,'host-component-700-tooltip.png'),
      clip:{x:0,y:0,width:700,height:Math.ceil(Math.max(hint.y+hint.height,row.y+row.height)+12)}});
  }
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>fixtureActivations),['fixture:1']);
  assert.equal(await page.evaluate(()=>String(getSelection())),'');
  assert.deepEqual(errors,[]);
});

async function verifyNextRaster(page,context,anchor,evidence,transition) {
  const directory=path.join(evidence,'next-raster');mkdirSync(directory,{recursive:true});
  const bounds=await anchor.boundingBox(),frames=[],session=await context.newCDPSession(page);
  const motion=page.evaluate(async()=>{
    const samples=[];
    for(let i=0;i<200;i++) {
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const popup=document.querySelector('.playback-restart-popover');
      if(popup.hidden) continue;
      const clip=getComputedStyle(popup,'::before').clipPath;
      const match=clip.match(/^inset\((.+?)(?: round .+)?\)$/);
      if(!match) throw Error('Capsule has no actual clipped surface');
      const values=match[1].split(/\s+/).map(Number.parseFloat);
      const [top,right=top,bottom=top,left=right]=values;
      samples.push({closing:popup.classList.contains('is-closing'),width:popup.offsetWidth-left-right,height:popup.offsetHeight-top-bottom});
    }
    return samples;
  });
  session.on('Page.screencastFrame',event=>{
    if(frames.length<128) {
      const name=String(frames.length).padStart(3,'0')+'.png';
      writeFileSync(path.join(directory,name),Buffer.from(event.data,'base64'));
      frames.push({name,timestamp:event.metadata.timestamp});
    }
    void session.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
  });
  try {
    await session.send('Page.startScreencast',{format:'png',everyNthFrame:1});
    await delay(120);
    assert.ok(frames.length,'A real baseline frame is required');
    await transition();
    const samples=await motion;
    for(const closing of [false,true]) {
      assert.ok(samples.some(frame=>frame.closing===closing&&frame.width>44.1&&frame.width<51.9&&Math.abs(frame.width-frame.height)<.1),
        'Entry/exit includes a real intermediate circle before/after lateral extension');
    }
    assert.ok(samples.some(frame=>frame.width>98),'Surface reaches the full capsule');
    writeFileSync(path.join(directory,'capsule-motion.json'),JSON.stringify(samples,null,2));
  } finally {
    await session.send('Page.stopScreencast');await session.detach();
    writeFileSync(path.join(directory,'frames.json'),JSON.stringify({bounds,frames},null,2)+'\n','utf8');
  }
  assert.ok(frames.length>=8 && frames.length<128,'Capture contains bounded intermediate animation frames');
  const raw=path.join(directory,'next.rgba'),width=44,height=44,stride=width*height*4;
  const decoded=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',path.join(directory,'%03d.png'),
    '-vf',`crop=44:44:${Math.floor(bounds.x)}:${Math.floor(bounds.y)}`,'-f','rawvideo','-pix_fmt','rgba',raw],process.env,10000);
  assert.equal(decoded.status,0,decoded.stderr);
  const pixels=readFileSync(raw),frequencies=new Map(),interior=[];
  assert.equal(pixels.length,frames.length*stride,'Each captured compositor frame is decoded');
  for(let y=3;y<41;y++)for(let x=3;x<41;x++) {
    if(Math.hypot(x+.5-22,y+.5-22)>19)continue;
    const offset=(y*width+x)*4;interior.push(offset);
    const rgb=Array.from(pixels.subarray(offset,offset+3)).join(',');
    frequencies.set(rgb,(frequencies.get(rgb)||0)+1);
  }
  const background=[...frequencies].sort((a,b)=>b[1]-a[1])[0][0].split(',').map(Number);
  const glyph=interior.filter(offset=>background.reduce((sum,color,c)=>sum+Math.abs(color-pixels[offset+c]),0)>160);
  assert.ok(glyph.length>=40,'The baseline contains the actual contrasting Next glyph');
  const differences=frames.map((frame,index)=>{
    let maximum=0;
    for(const offset of glyph)for(let c=0;c<3;c++)maximum=Math.max(maximum,Math.abs(pixels[index*stride+offset+c]-pixels[offset+c]));
    return {...frame,maximum};
  });
  writeFileSync(path.join(directory,'glyph-differences.json'),JSON.stringify({glyphPixels:glyph.length,differences},null,2)+'\n','utf8');
  // Allow the slight translucent background change; a lost glyph differs by
  // over 200 in the reproduced broken build. This checks raster, not CSS.
  assert.ok(differences.every(frame=>frame.maximum<=8),'Next glyph survives every actual capsule entry/exit frame');
}

// Keep timestamp ownership separate from the restart component's visual checks.
test('real native playback records its first start after blocked media loading', {
  skip:process.platform!=='linux' && 'Linux native/browser fixture; native device acceptance is separate', timeout:120000,
},async t=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-played-start-'));
  let host,browser;
  const gate=Promise.withResolvers(),requested=Promise.withResolvers();let blocked=true;
  t.after(async()=>{gate.resolve();await browser?.close();await host?.close();rmSync(home,{recursive:true,force:true});});
  for(const [file,args] of [
    ['video.mp4',['-f','lavfi','-i','color=c=0x224466:s=640x360:r=10:d=30','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p']],
    ['audio.m4a',['-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=30','-c:a','aac']],
  ]) {
    const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,path.join(home,file)],process.env,30000);
    assert.equal(result.status,0,result.stderr);
  }
  host=await RunningHost.start(process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha(),home,
    [home,path.join(root,'static'),path.join(home,'video.mp4'),path.join(home,'audio.m4a'),'1'],isolatedEnvironment(home),true);
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1000,height:800}});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
  await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin!==host.base)return route.abort();
    if(u.pathname.startsWith('/media/')&&blocked){requested.resolve();await gate.promise;}
    return route.continue();
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(host.base,{waitUntil:'domcontentloaded'});
  await requested.promise;
  const pending=await host.api('/api/state');
  assert.ok(pending.current_item);
  assert.equal(pending.current_item_started,false);
  assert.deepEqual(pending.session_played,[],'Selection and media loading are not a playback start');
  const evidence=process.env.BILIKARA_RESTART_SCREENSHOTS;
  if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,'played-start-waiting.png')});}
  const earliest=Date.now()/1000;
  blocked=false;gate.resolve();
  await page.waitForFunction(()=>state.data?.player_status?.observed_phase==='playing'&&state.data.session_played?.length===1);
  const started=await host.api('/api/state'),stamp=started.session_played[0].played_at;
  assert.ok(stamp>=earliest&&stamp<=Date.now()/1000,'Use actual playback confirmation, excluding the media wait');
  const checkpoint=JSON.parse(readFileSync(path.join(home,'host-state.json'),'utf8'));
  const persisted=JSON.parse(Buffer.concat(checkpoint.records.session_played.map(name=>readFileSync(path.join(home,'host-records',name)))));
  assert.equal(persisted[0].played_at,stamp);
  const identity={item_id:started.current_item.id,playback_generation:started.playback_generation};
  for(const [action,phase] of [['pause','paused'],['play','playing']]){
    await host.api('/api/player/control',{...identity,action});
    await page.waitForFunction(value=>state.data?.player_status?.observed_phase===value,phase);
    const current=await host.api('/api/state');
    assert.equal(current.session_played.length,1);
    assert.equal(current.session_played[0].played_at,stamp,'Pause/resume must retain the first start');
  }
  assert.deepEqual(errors,[]);
  if(evidence){
    await page.screenshot({path:path.join(evidence,'played-start-confirmed.png')});
    writeFileSync(path.join(evidence,'played-start-result.json'),JSON.stringify({passed:true,pendingRecords:pending.session_played,earliest,playedAt:stamp,persistedAt:persisted[0].played_at,errors,browser:await browser.version()},null,2)+'\n','utf8');
  }
});
