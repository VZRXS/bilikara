"use strict";
// Extension of the existing imported-destination browser fixture, not a Host.
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const path=require("node:path");
module.exports=async ({api,okay,capture,browser,evidence,getPage,restart,inspectPersisted})=>{
  let page=getPage(); const errors=[], browserWarnings=[];
  const watch=p=>{p.on("pageerror",e=>errors.push(e.message));p.on("console",m=>{if(m.text()==='Viewport argument key "interactive-widget" not recognized and ignored.')browserWarnings.push(m.text());else if(m.type()==="error" && !/status of (400|403|409|501)/.test(m.text()))errors.push(m.text());});};watch(page);
  const control=async name=>(await fetch(process.env.DESKTOP_FIXTURE_CONTROL+"/fixture/cache-"+name)).json();
  const stats=()=>control("stats");
  const until=async fn=>{const end=Date.now()+25000;do{if(await fn())return;await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);throw Error("Cache policy fixture condition timed out");};
  const caps=(index,hevc=true,avc=true)=>okay("/api/client/media-capabilities",{hevc_supported:hevc,avc_supported:avc,max_avc_quality_index:index});
  const stable=async expected=>{
    // Observe several existing pump intervals; identical settings must not mint work.
    for(let n=0;n<5;n++){await okay("/api/state");await new Promise(r=>setTimeout(r,180));}
    assert.equal((await stats()).media.length,expected);
  };
  await page.locator("#cache-settings-toggle").click();
  await page.locator("#cache-quality-select").selectOption("1080P 高清");
  await page.waitForFunction(()=>state.data.cache_policy.video_quality==="1080P 高清");
  await page.locator('label[for="cache-hires-checkbox"]').click();
  await page.locator("#cache-limit-slider").focus();await page.locator("#cache-limit-slider").press("Home");
  await page.waitForFunction(()=>state.data.cache_policy.max_cache_items===1 && !state.data.cache_policy.audio_hires);
  const stored=await inspectPersisted();
  const invalid=await api("/api/cache-policy",{max_cache_items:0,video_quality:"360P 流畅"});assert.equal(invalid.status,400);
  assert.equal(await inspectPersisted(),stored,"Rejected mixed patch must preserve the entire stored policy");
  await caps(3); // The existing quality service maps this to 480P, not requested 1080P.
  await control("delay");
  await page.locator("#cache-download-source-select").selectOption("native");
  await until(async()=> (await stats()).media.some(v=>v.path==="/video.mp4" && v.quality==="32"));
  const started=Date.now();await okay("/api/player/volume",{volume_percent:41});assert.ok(Date.now()-started<1500,"Playback settings blocked behind a media job");
  await caps(4); // Replace the delayed old attempt with a narrower actual decode limit.
  await page.waitForFunction(()=>state.data.cache_policy.effective_video_quality==="360P 流畅");
  await control("release");
  await page.waitForFunction(()=>state.data.current_item.cache_status==="ready",null,{timeout:25000});
  let snapshot=await okay("/api/state");
  assert.equal(snapshot.cache_policy.avc_quality_cap,"360P 流畅");
  assert.equal(snapshot.cache_policy.media_capabilities.hevc_supported,true);
  assert.equal(snapshot.cache_policy.media_backend.hevc_available,false);
  let requests=(await stats()).media;assert.ok(requests.some(v=>v.quality==="16"));
  assert.ok(requests.filter(v=>v.path==="/video.mp4").every(v=>v.codec==="7"));
  const artifact=snapshot.current_item.artifact_set_id;
  await until(async()=>(await okay("/api/state")).cache_policy.usage_bytes>0);
  assert.equal((await okay("/api/state")).cache_policy.cached_item_count,1);
  await capture("cache-policy-desktop.png",page);
  const baseline=(await stats()).media.length;
  const before=await inspectPersisted();
  for(let n=0;n<4;n++)await okay("/api/cache-policy",{video_quality:"1080P 高清",max_cache_items:1});
  assert.equal(await inspectPersisted(),before);
  await caps(4,false); // Different HEVC fact, identical AVC backend inputs.
  await okay("/api/cache-policy",{video_quality:"720P 高清",reset_offset_on_next:false});
  await stable(baseline);assert.equal((await okay("/api/state")).current_item.artifact_set_id,artifact);
  await page.locator('label[for="cache-hires-checkbox"]').click();
  await until(async()=> (await stats()).media.some(v=>v.path==="/audio-flac.mp4"));
  await page.waitForFunction(old=>state.data.current_item.cache_status==="ready" && state.data.current_item.artifact_set_id!==old,artifact,{timeout:25000});
  snapshot=await okay("/api/state");
  assert.ok(snapshot.current_item.audio_variants.some(v=>v.audio_url.endsWith(".flac")));
  const refreshed=snapshot.current_item.artifact_set_id;
  await caps(4,true,false);
  await page.waitForFunction(()=>!state.data.cache_policy.enabled && !state.data.current_item.video_media_url);
  const unsupported=await api("/api/cache/retry",{item_id:snapshot.current_item.id,expected_item_incarnation_id:snapshot.current_item.item_incarnation_id,force:true});
  assert.equal(unsupported.status,501);assert.equal(unsupported.body.code,"player_media_unavailable");
  await caps(4,true,true);
  await page.waitForFunction(old=>state.data.current_item.cache_status==="ready" && state.data.current_item.artifact_set_id!==old,refreshed,{timeout:25000});
  await okay("/api/cache-policy",{max_cache_items:2});
  await until(async()=>(await okay("/api/state")).cache_policy.cached_item_count===2);
  const queuedArtifact=(await okay("/api/state")).playlist[0].artifact_set_id;
  await okay("/api/cache-policy",{max_cache_items:1});
  await until(async()=>(await okay("/api/state")).cache_policy.cached_item_count===1);
  await okay("/api/cache-policy",{max_cache_items:2});
  await until(async()=>{const state=await okay("/api/state");return state.cache_policy.cached_item_count===2 && state.playlist[0].artifact_set_id!==queuedArtifact;});
  await okay("/api/cache-policy",{max_cache_items:1});
  const remoteContext=await browser.newContext({viewport:{width:375,height:812}});
  try {
    const remote=await remoteContext.newPage();watch(remote);
    const invite=(await okay("/api/state")).remote_access.lan_urls[0];assert.ok(invite);
    await remote.goto(invite);await remote.waitForURL(new URL("/remote",invite).href);
    await remote.locator("#remote-identity-input").fill("Cache Remote");await remote.locator("#remote-identity-submit").click();
    await remote.waitForFunction(()=>document.querySelector("#remote-identity-modal").classList.contains("hidden"));
    const denied=await remote.evaluate(async()=>{
      const result=await fetch("/api/client/media-capabilities",{method:"POST",headers:clientHeaders({"Content-Type":"application/json"}),body:JSON.stringify({hevc_supported:false,avc_supported:false})});return result.status;
    });assert.equal(denied,403);
    assert.equal((await okay("/api/state")).cache_policy.media_capabilities.avc_supported,true);
    await remote.locator("#playback-dock").click();
    await remote.locator("#remote-volume-slider").focus();await remote.locator("#remote-volume-slider").press("End");
    await page.waitForFunction(()=>state.data.player_settings.volume_percent===100);
    await capture("cache-policy-remote-375.png",remote);
    await okay("/api/cache-policy",{reset_offset_on_next:true});
    await okay("/api/player/av-delay-action",{type:"set_effective",effective_delay_ms:620});
    const prior=await okay("/api/state");
    await remote.evaluate(()=>sendPlayerNext());
    await page.waitForFunction(id=>state.data.current_item.id!==id,prior.current_item.id);
    const next=await okay("/api/state");
    assert.equal(next.player_settings.av_delay.local_delay_ms,0);assert.equal(next.player_settings.av_delay.global_delay_ms,320);
    await page.waitForFunction(()=>state.data.current_item.cache_status==="ready",null,{timeout:25000});
  } finally {await remoteContext.close();}
  const persisted=await inspectPersisted();const policy=JSON.parse(persisted).cache;
  assert.equal(policy.download_source,"native");assert.equal(policy.audio_hires,true);assert.equal(policy.reset_offset_on_next,true);
  assert.equal(policy.retained_settings.cache_policy.future_option,"keep");
  await restart(async ready=>{
    const context=await browser.newContext();await context.request.get(ready.bootstrapUrl);
    const response=await context.request.get(ready.baseUrl+"/api/state");const state=(await response.json()).data;
    assert.deepEqual(state.cache_policy.media_capabilities,{},"Player facts must not survive a runtime restart");
    assert.equal(state.cache_policy.avc_quality_cap,"");await context.close();
  });
  page=getPage();watch(page);
  assert.equal(await inspectPersisted(),persisted);
  await page.waitForFunction(()=>state.data.current_item.cache_status==="ready",null,{timeout:25000});
  assert.equal((await okay("/api/state")).cache_policy.video_quality,"720P 高清");
  await page.waitForFunction(()=>state.data.cache_policy.usage_bytes>0);
  await page.locator("#cache-settings-toggle").click();await capture("cache-policy-restarted.png",page);
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(evidence,"cache-policy-summary.json"),JSON.stringify({passed:true,desktopCounts:[1,2,3,4,5],disabledCachingSupported:false,actualRustJobs:true,delayedReplacement:true,hiresFlac:true,effectiveNoop:true,atomicRejectedPatch:true,restartPersistence:true,transientPlayerFacts:true,remoteViewport:[375,812],realDataChannel:false,consoleErrors:errors,browserWarnings},null,2));
};
