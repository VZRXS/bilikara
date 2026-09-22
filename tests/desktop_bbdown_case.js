"use strict";
// Real HTTP -> scheduler -> supervised child -> media -> artifact -> AppState.
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path");
module.exports=async({api,okay,capture,browser,evidence,directory,getPage,restart,shutdown})=>{
  const root=process.env.BILIKARA_BBDOWN_FIXTURE_ROOT;
  let page=getPage();const errors=[],warnings=[];
  function watch(){page.on("pageerror",e=>errors.push(e.message));page.on("console",m=>{
    if(m.text().includes('Viewport argument key "interactive-widget"'))warnings.push(m.text());
    else if(m.type()==="error" && !/status of (400|403|409|501)/.test(m.text()))errors.push(m.text());
  });}watch();
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async fn=>{const end=Date.now()+30000;do{if(await fn())return;await sleep(100);}while(Date.now()<end);throw Error("BBDown condition timed out");};
  const mode=value=>fs.writeFile(path.join(root,"mode"),value);
  const starts=async()=> (await fs.readdir(root)).filter(v=>v.endsWith(".started"));
  const running=async()=>{const result=[];for(const file of await starts()){const pid=Number(file.split(".")[0]);try{await fs.stat(`/proc/${pid}`);result.push(pid);}catch{}}return result;};
  const reaped=async pids=>{await until(async()=>{for(const pid of pids){try{await fs.stat(`/proc/${pid}`);return false;}catch{}}return true;});};
  const current=async()=> (await okay("/api/state")).current_item;
  const ready=async()=>{await until(async()=> (await current()).cache_status==="ready");return current();};
  const retry=async()=>{const item=await current();return okay("/api/cache/retry",{item_id:item.id,expected_item_incarnation_id:item.item_incarnation_id});};
  const caps=avc=>okay("/api/client/media-capabilities",{hevc_supported:false,avc_supported:avc,max_avc_quality_index:4});
  // Baseline import already proved missing BBDown is preserved and unavailable.
  assert.equal((await api("/api/cache-policy",{download_source:"bbdown"})).status,501);
  await okay("/api/cache-policy",{download_source:"native",max_cache_items:1,audio_hires:false});
  await ready();
  process.env.BILIKARA_BBDOWN_ACTIVE=process.env.BILIKARA_BBDOWN_FIXTURE;
  await restart();page=getPage();watch();await ready();
  await page.locator("#cache-settings-toggle").click();
  const choices=(await okay("/api/state")).cache_policy.download_source_choices.map(v=>v.value);
  assert.deepEqual(choices,["native","bbdown","downkyi"]);
  assert.ok(await page.title());assert.ok((await page.locator("body").innerText()).includes("Imported desktop song"));
  if(process.env.BILIKARA_BBDOWN_REAL){
    const previous=await current();
    await page.locator("#cache-download-source-select").selectOption("bbdown");
    await until(async()=> (await current()).artifact_set_id!==previous.artifact_set_id);
    const item=await ready();assert.ok(item.audio_variants.length);assert.ok(item.video_media_url.startsWith("/media/"));
    const video=await page.request.get(new URL(item.video_media_url,page.url()).href);assert.equal(video.status(),200);assert.ok((await video.body()).length>0);
    await capture("bbdown-pinned-ready.png",page);
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(evidence,"bbdown-summary.json"),JSON.stringify({passed:true,pinnedBBDown:"1.6.3",realChild:true,nonForwardingTLSFixture:true,providerDownloadTested:false,applicationPathEmpty:true,pythonBackend:false,mediaValidated:true,consoleErrors:errors,browserWarnings:warnings},null,2));
    return;
  }
  // Guest admission must fail without a child; fixture login enables retry without restarting.
  await caps(false);
  await until(async()=> !(await current()).video_media_url);
  await fetch(process.env.DESKTOP_FIXTURE_CONTROL+"/fixture/login-wait");
  await okay("/api/bbdown/logout",{});
  const guestStarts=(await starts()).length;
  await page.locator("#cache-download-source-select").selectOption("bbdown");
  await caps(true);
  await until(async()=> (await current()).cache_status==="failed");
  assert.match((await current()).cache_message,/下载需要登录 Bilibili/);
  await page.waitForFunction(()=>document.querySelector("#app-toast")?.textContent.includes("Sign in to Bilibili"));
  await capture("bbdown-login-required.png",page);
  const guest=await current();
  assert.equal((await api("/api/cache/retry",{item_id:guest.id,expected_item_incarnation_id:guest.item_incarnation_id})).status,403);
  for(let n=0;n<4;n++)await okay("/api/state");
  assert.equal((await starts()).length,guestStarts);
  assert.match(await fs.readFile(path.join(directory,"logs/native",guest.id+".log"),"utf8"),/download_login_required source=bbdown/);
  await fetch(process.env.DESKTOP_FIXTURE_CONTROL+"/fixture/login-ready");
  await okay("/api/bbdown/login/start",{});
  await until(async()=> (await okay("/api/state")).bbdown.logged_in);
  await mode("success");await retry();await ready();
  await page.waitForFunction(()=>state.data.current_item.cache_status==="ready" && state.data.bbdown.logged_in);
  await capture("bbdown-login-retry-ready.png",page);
  const loggedInArtifact=(await current()).artifact_set_id;
  await page.locator("#cache-download-source-select").selectOption("native");
  await until(async()=> (await current()).artifact_set_id!==loggedInArtifact);
  await ready();
  await page.waitForFunction(()=>state.data.cache_policy.download_source==="native" && !state.cachePolicySaving);
  await mode("late");
  await page.locator("#cache-download-source-select").selectOption("bbdown");
  await until(async()=> (await running()).length>=2);
  const oldPids=await running(),old=await current();
  await until(async()=>{for(const pid of oldPids){try{await fs.stat(path.join(root,`${pid}.completed`));}catch{return false;}}return true;});
  const oldDirectories=await Promise.all(oldPids.map(async pid=>(await fs.readFile(path.join(root,`${pid}.started`),"utf8")).split("\n")[3]));
  assert.equal((await okay("/api/state")).cache_policy.download_source,"bbdown");
  const started=Date.now();await okay("/api/player/volume",{volume_percent:46});assert.ok(Date.now()-started<1500,"slow BBDown blocked controls");
  await page.waitForFunction(()=>state.data.player_settings.volume_percent===46 && state.data.current_item.cache_progress<100);
  await capture("bbdown-progress-desktop.png",page);
  // Source replacement must kill/reap the child and retain Native dispatch.
  await page.locator("#cache-download-source-select").selectOption("native");
  await reaped(oldPids);await until(async()=> (await current()).artifact_set_id!==old.artifact_set_id);const native=await ready();assert.notEqual(native.artifact_set_id,old.artifact_set_id);
  for(const oldDirectory of oldDirectories)await assert.rejects(fs.stat(oldDirectory),"Old owned staging must settle after source replacement");
  const count=(await starts()).length;await sleep(1500);assert.equal((await starts()).length,count);
  await mode("success");await page.locator("#cache-download-source-select").selectOption("bbdown");
  let success=await ready();
  await until(async()=> (await starts()).length>count && (await current()).artifact_set_id!==native.artifact_set_id);
  success=await ready();assert.ok(success.video_media_url.startsWith("/media/"));
  assert.ok(success.audio_variants.every(v=>v.audio_url.startsWith("/media/")));
  const response=await page.request.get(new URL(success.video_media_url,page.url()).href);assert.equal(response.status(),200);assert.ok((await response.body()).length>0);
  await capture("bbdown-ready-desktop.png",page);
  // Hi-Res uses actual FLAC-in-MP4 input and shared normalization to .flac.
  await okay("/api/cache-policy",{audio_hires:true});
  await until(async()=>{const item=await current();return item.cache_status==="ready" && item.audio_variants.some(v=>v.audio_url.endsWith(".flac"));});
  // Evict the readable artifact so failures exercise first-download semantics.
  await caps(false);await until(async()=> !(await current()).video_media_url);
  await mode("missing");await caps(true);
  await until(async()=> (await current()).cache_status==="failed");
  const outcomes=[];
  for(const failure of ["missing","invalid","exit"]){
    await mode(failure);const before=(await starts()).length;await retry();
    await until(async()=> (await current()).cache_status==="failed");
    await reaped(await running());await sleep(1800);
    const after=(await starts()).length;
    assert.ok(after>before && after-before<=2,`${failure}: retry explosion ${after-before}`);
    for(let n=0;n<5;n++)await okay("/api/state");await sleep(1000);assert.equal((await starts()).length,after);
    const failed=await current();assert.ok(!failed.cache_message.includes("synthetic-secret-output"));
    outcomes.push({failure,children:after-before,message:failed.cache_message});
  }
  await capture("bbdown-failed-desktop.png",page);
  const beforeUnsupported=(await starts()).length;
  await fetch(process.env.DESKTOP_FIXTURE_CONTROL+"/fixture/bbdown-no-dash");
  await mode("success");await retry();await until(async()=> (await current()).cache_status==="failed");
  await sleep(1500);assert.equal((await starts()).length,beforeUnsupported,"Unsupported segmented source must not start BBDown's legacy merger");
  await fetch(process.env.DESKTOP_FIXTURE_CONTROL+"/fixture/bbdown-dash");
  // Retry supersedes an active attempt. Old results cannot become ready.
  await mode("slow");await retry();await until(async()=> (await running()).length>=2);
  const retryPids=await running();await mode("success");await retry();await reaped(retryPids);await ready();
  // Cache disablement uses existing player capability settlement, then re-entry.
  await mode("slow");await retry();await until(async()=> (await running()).length>=2);
  const disabledPids=await running();await caps(false);await reaped(disabledPids);
  assert.equal((await okay("/api/state")).cache_policy.enabled,false);
  await until(async()=> !(await current()).video_media_url);
  await mode("late");await caps(true);await until(async()=> (await running()).length>=2);
  await page.waitForFunction(()=>state.data.cache_policy.download_source==="bbdown"
    && state.data.current_item.cache_status==="downloading"
    && state.data.current_item.cache_download_tracks.length===2
    && state.data.current_item.cache_message.includes("总计"));
  await capture("bbdown-active-download.png",page);
  await mode("success");await retry();await ready();
  // Window shrink cancels queued-item work; re-entry gets a fresh attempt.
  await mode("slow");await okay("/api/cache-policy",{max_cache_items:2});await until(async()=> (await running()).length>=2);
  const windowPids=await running();await okay("/api/cache-policy",{max_cache_items:1});await reaped(windowPids);
  await mode("success");await okay("/api/cache-policy",{max_cache_items:2});
  await until(async()=> (await okay("/api/state")).playlist[0].cache_status==="ready");
  const queued=(await okay("/api/state")).playlist[0];
  await mode("slow");await okay("/api/cache/retry",{item_id:queued.id,expected_item_incarnation_id:queued.item_incarnation_id});
  await until(async()=> (await running()).length>=2);const removedPids=await running();
  await okay("/api/playlist/remove",{item_id:queued.id});await reaped(removedPids);await sleep(1000);
  assert.ok(!(await okay("/api/state")).playlist.some(v=>v.id===queued.id));
  // Multi-page command selection preserves audio variant ordering and identity.
  await mode("success");
  await okay("/api/playlist/add",{url:"https://www.bilibili.com/video/BV1xx411c7mE",requester_name:"Alice",selected_video_page:1,selected_audio_pages:[1,2]});
  await until(async()=> (await okay("/api/state")).playlist[0]?.cache_status==="ready");
  const multi=(await okay("/api/state")).playlist[0];assert.deepEqual(multi.audio_variants.map(v=>v.page),[1,2]);
  assert.equal(new Set(multi.audio_variants.map(v=>v.id)).size,2);
  // Reader/UI remains responsive with the chosen source visible on Remote.
  const remoteContext=await browser.newContext({viewport:{width:375,height:812}});
  const remote=await remoteContext.newPage();remote.on("pageerror",e=>errors.push(e.message));
  const invite=(await okay("/api/state")).remote_access.lan_urls[0];await remote.goto(invite);await remote.waitForURL(new URL("/remote",invite).href);
  await remote.locator("#remote-identity-input").fill("BBDown Fixture");await remote.locator("#remote-identity-submit").click();
  await remote.waitForFunction(()=>document.querySelector("#remote-identity-modal").classList.contains("hidden"));
  await capture("bbdown-remote-375.png",remote);await remoteContext.close();
  await mode("slow");await retry();await until(async()=> (await running()).length>=2);const shutdownPids=await running();
  await shutdown();await reaped(shutdownPids);
  // A missing configured tool on restart must not silently substitute Native.
  process.env.BILIKARA_BBDOWN_ACTIVE=path.join(root,"missing-BBDown");
  // restart's common stop is idempotently skipped by the harness after shutdown.
  await restart();page=getPage();watch();
  const unavailable=await okay("/api/state");assert.equal(unavailable.cache_policy.download_source,"bbdown");assert.equal(unavailable.cache_policy.enabled,false);
  assert.equal((await api("/api/cache/retry",{item_id:unavailable.current_item.id,expected_item_incarnation_id:unavailable.current_item.item_incarnation_id})).status,501);
  const log=(await Promise.all((await fs.readdir(path.join(directory,"logs/native"))).map(name=>fs.readFile(path.join(directory,"logs/native",name),"utf8")))).join("\n");assert.ok(!/synthetic-secret-output|synthetic-import|synthetic-csrf/.test(log));
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(evidence,"bbdown-summary.json"),JSON.stringify({passed:true,fixtureChild:true,providerDownloadTested:false,pythonBackend:false,applicationPathEmpty:true,choices,success:true,hiresFlac:true,multiPageAudio:true,sourceReplacement:true,lateOldStagingResult:true,nonDashRejectedBeforeChild:true,userRetry:true,disablement:true,windowShrink:true,removal:true,shutdown:true,unavailable:true,outcomes,consoleErrors:errors,browserWarnings:warnings},null,2));
};
