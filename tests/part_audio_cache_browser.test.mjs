// Render the shipped selectors and click handlers. Rust tests independently
// qualify cache admission, immutable publication and playback-program ownership.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {chromium,webkit} from 'playwright';
const root=path.resolve(import.meta.dirname,'..');
const source=name=>readFileSync(path.join(root,'static',name),'utf8');
const slice=(s,start,end)=>{const a=s.indexOf(start),b=s.indexOf(end,a);assert.ok(a>=0&&b>a);return s.slice(a,b);};

for(const engine of [chromium,webkit])for(const [platform,width] of [['desktop',1000],['android',393],['ios',393],['remote',393]])test(`${engine.name()} ${platform} part cache keeps labels and nodes until verified ready`,{timeout:30000,skip:process.platform!=='linux'},async t=>{
  const remote=platform==='remote',code=source(remote?'remote.js':'app.js');
  const browser=await engine.launch(engine===chromium?{args:['--disable-gpu']}:{});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:800},hasTouch:platform!=='desktop',reducedMotion:'reduce'}),errors=[];
  page.setDefaultTimeout(5000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.setContent('<title>bilikara part cache fixture</title><main id="panel"><video id="media"></video><div id="body"><div id="anchor"><div id="bar"></div><button id="toggle"></button></div></div><div id="popover" hidden></div><div id="backdrop" hidden></div></main>');
  assert.equal(page.url(),'about:blank');assert.equal(await page.title(),'bilikara part cache fixture');
  await page.locator('#toggle').evaluate((n,remote)=>{if(remote)n.remove();else n.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';},remote);
  for(const file of ['accent-palette.css',remote?'remote.css':'styles.css',...(remote?[]:['host-layout.css']),'ui-surfaces.css'])await page.addStyleTag({content:source(file).replace(/@import[^;]+;/g,'')});
  await page.addStyleTag({content:'body{margin:0;padding:20px}#panel{position:relative;height:740px;max-width:640px;margin:auto}#body{padding-top:250px}#anchor{width:100%}#bar{margin:0}#popover{box-sizing:border-box}#media{display:none}#backdrop{pointer-events:none}'});
  await page.addScriptTag({path:path.join(root,'static/part-selector.js')});
  await page.evaluate(({platform,remote})=>{
    document.documentElement.dataset.hostPlatform=platform;
    document.documentElement.dataset.hostLayout=['android','ios'].includes(platform)?'portrait':'landscape';
    const el=id=>document.getElementById(id);
    el('bar').className='audio-variant-bar';el('anchor').className='audio-variant-anchor';el('popover').className='audio-variant-popover';if(el('toggle'))el('toggle').className='audio-variant-toggle';
    window.elements={audioVariantBar:el('bar'),audioVariantAnchor:el('anchor'),audioVariantToggle:el('toggle'),audioVariantPopover:el('popover'),audioVariantBackdrop:el('backdrop'),playbackSheetPanel:el('panel'),playbackSheetBody:el('body')};
    const item={id:'song',item_incarnation_id:'fixture-incarnation',cache_status:'ready',video_media_url:'/media/original/video.mp4',selected_audio_variant_id:'p1_main',available_pages:Array.from({length:20},(_,i)=>i+1),available_parts:['P1 原声','P2 伴奏',...Array.from({length:18},(_,i)=>`P${i+3} 其他音轨`)],available_durations:Array(20).fill(120),selected_pages:[1],audio_variants:[{id:'p1_main',label:'P1 原声',page:1,audio_url:'/media/original/audio1.m4a'}]};
    window.state={data:{current_item:item,playlist:[],playback_mode:'local',audio_supplements:{}},language:'zh',audioVariantBarRenderSignature:'',audioVariantBarItemId:'',audioVariantBarExpanded:false,audioVariantSwitchInFlight:false,audioVariantSwitchUnlockAt:0,hostPlaybackSession:{video:el('media'),audio:{},logicalPlayIntent:true}};
    window.originalItem=structuredClone(item);
    window.t=k=>k;window.audioVariantSwitchLocked=()=>false;window.audioVariantSwitchDebounceMs=500;
    window.setClassToggle=(n,k,v)=>n?.classList.toggle(k,v);window.stageControlsAreInline=()=>true;
    window.closeCacheAdvancedInfo=window.setRemoteQrPinned=window.schedulePersistentStageMeasurement=window.scheduleAudioVariantSwitchUnlock=()=>{};
    window.playbackCssPixels=v=>parseFloat(v)||0;window.frontendPlaybackMode=()=> 'local';window.isCurrentHostPlaybackSession=()=>true;
    window.requests=[];window.messages=[];window.setAppMessage=window.setFormMessage=(message,error)=>messages.push({message,error});
    window.savedMedia=el('media');
    window.apiPostExactStateCommand=async(url,body)=>{
      requests.push({url,body});
      if(url==='/api/cache/audio'){
        if(window.failCache)throw new Error('fixture failure');
        await new Promise(resolve=>{window.finishCache=resolve;});
      }else if(url==='/api/player/audio-variant')state.data.current_item.selected_audio_variant_id=body.variant_id;
      else throw new Error('Unexpected endpoint');
      return {commandApplied:true,snapshotAccepted:true};
    };
  },{platform,remote});
  await page.addScriptTag({content:slice(code,'function audioVariantsForItem',remote?'function audioVariantSwitchLocked':'function selectedVideoUrlForItem')});
  await page.addScriptTag({content:remote?slice(code,'function audioVariantPopover()','function boundedRemoteVolumePercent'):slice(code,'function preferredAudioVariantPopoverDirection','function renderAvSyncControls')});
  await page.addScriptTag({content:slice(code,'async function handleAudioVariantSelection','elements.audioVariantBar.addEventListener("click", handleAudioVariantSelection)')});
  await page.evaluate(()=>{
    window.render=()=>renderAudioVariantBar(state.data.current_item,'local');
    elements.audioVariantBar.addEventListener('click',handleAudioVariantSelection);elements.audioVariantPopover.addEventListener('click',handleAudioVariantSelection);render();
  });
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  const button=page.locator('#bar [data-page="2"]');
  assert.equal(await button.textContent(),'P2 伴奏');assert.equal(await button.isEnabled(),true);
  assert.equal(await button.evaluate(n=>getComputedStyle(n).borderStyle),'dashed');
  assert.equal(await button.evaluate(n=>getComputedStyle(n,'::after').content),'none');
  await page.evaluate(()=>setAudioVariantPopoverOpen(true));
  await page.locator('#popover [data-page="2"]').click();
  await page.evaluate(()=>{window.savedPart=document.querySelector('#bar [data-page="2"]');savedPart.click();});
  assert.equal(await page.evaluate(()=>requests.length),1);
  assert.deepEqual(await page.evaluate(()=>requests[0]),{url:'/api/cache/audio',body:{item_id:'song',expected_item_incarnation_id:'fixture-incarnation',page:2}});
  for(const progress of [10,25,55])await page.evaluate(progress=>{state.data.audio_supplements.song={item_incarnation_id:'fixture-incarnation',page:2,status:'downloading',progress,ready:null};render();},progress);
  await page.waitForFunction(()=>document.querySelector('#bar [data-page="2"]').style.getPropertyValue('--audio-cache-progress')==='55%');
  assert.equal(await page.evaluate(()=>document.querySelector('#bar [data-page="2"]')===savedPart),true);
  assert.equal(await button.textContent(),'P2 伴奏');assert.equal(await button.isEnabled(),false);
  const fill=await button.locator('.audio-part-progress').boundingBox(),bounds=await button.boundingBox();
  assert.ok(fill.width>bounds.width*.50&&fill.width<bounds.width*.60,'the fill reflects the actual 55 percent progress');
  assert.equal(await button.evaluate(n=>getComputedStyle(n).overflow),'hidden','progress stays inside the rounded pill');
  assert.equal(await page.evaluate(()=>state.audioVariantBarExpanded),true);
  const evidence=process.env.BILIKARA_PART_CACHE_EVIDENCE;
  if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${platform}-${engine.name()}-progress.png`)});await page.locator('#bar').screenshot({path:path.join(evidence,`${platform}-${engine.name()}-bar-progress.png`)});}
  await page.evaluate(()=>{
    state.data.audio_supplements.song.status='ready';state.data.audio_supplements.song.progress=100;
    state.data.audio_supplements.song.ready={audio_variants:[...state.data.current_item.audio_variants,{id:'p2_extra',label:'P2 伴奏',page:2,audio_url:'/media/candidate/audio2.m4a'}]};
    finishCache();render();
  });
  await button.waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#bar [data-page="2"]').disabled);
  assert.equal(await button.textContent(),'P2 伴奏');assert.equal(await button.evaluate(n=>getComputedStyle(n).borderStyle),'solid');
  if(evidence){await page.screenshot({path:path.join(evidence,`${platform}-${engine.name()}-ready.png`)});await page.locator('#bar').screenshot({path:path.join(evidence,`${platform}-${engine.name()}-bar-ready.png`)});}
  assert.equal(await page.evaluate(()=>state.data.current_item.selected_audio_variant_id),'p1_main');
  assert.equal(await page.evaluate(()=>state.data.playlist.length),0);
  assert.equal(await page.evaluate(()=>document.getElementById('media')===savedMedia),true);
  for (const mode of ['file_required', 'pending', 'remux']) {
    await page.evaluate(mode=>{
      state.data.media_output={target:'purek',audio_track_switch:mode};
      render();
    },mode);
    assert.equal(await button.isEnabled(),mode==='remux',`track availability follows ${mode}`);
    assert.equal(await button.getAttribute('aria-description'),mode==='remux'?'cast.trackRemux':`cast.error.cast_track_${mode}`);
    assert.equal(await page.evaluate(()=>state.data.current_item.selected_audio_variant_id),'p1_main');
  }
  await page.locator('#popover [data-page="2"]').click();
  await page.waitForFunction(()=>state.data.current_item.selected_audio_variant_id==='p2_extra');
  assert.equal(await page.evaluate(()=>requests.filter(r=>r.url==='/api/player/audio-variant').length),1);
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.error)),[]);
  await page.evaluate(()=>{
    state.data.current_item=structuredClone(originalItem);
    state.data.audio_supplements.song.item_incarnation_id='retired-incarnation';
    render();
  });
  assert.equal(await button.evaluate(n=>getComputedStyle(n).borderStyle),'dashed','old-incarnation candidates are ignored');
  await page.evaluate(()=>{state.data.audio_supplements={};window.failCache=true;setAudioVariantPopoverOpen(true);});
  await page.locator('#popover [data-page="2"]').click();
  await page.waitForFunction(()=>messages.some(m=>m.error));
  assert.equal(await button.isEnabled(),true,'failed admission releases the pill for retry');
  assert.equal(await button.getAttribute('aria-busy'),null);
  assert.equal(await button.textContent(),'P2 伴奏');
  await page.evaluate(()=>{
    window.failCache=false;messages.length=0;
    state.data.audio_supplements.song={item_incarnation_id:'fixture-incarnation',cache_attempt_token:20,page:2,status:'failed',progress:null,ready:null,message:'P2: media access forbidden (HTTP 403)'};
    render();render();
  });
  assert.equal(await button.getAttribute('data-audio-cache'),'failed','worker failure must remain visible after the spinner stops');
  assert.match(await button.getAttribute('title'),/HTTP 403/);
  assert.equal(await button.isEnabled(),true,'a terminal failure allows an explicit retry');
  assert.equal(await button.getAttribute('aria-busy'),null);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.error).length),1,'one failure notification per attempt, despite progress paints');
  await page.evaluate(()=>{state.data.audio_supplements.song.cache_attempt_token=21;render();});
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.error).length),2,'a new failed retry reports its reason even if its queued frame was not observed');
  await page.evaluate(()=>{state.data.audio_supplements.song.item_incarnation_id='retired-incarnation';render();});
  assert.equal(await button.getAttribute('data-audio-cache'),'','retired failures cannot mark the next incarnation');
  assert.deepEqual(errors,[]);
});
