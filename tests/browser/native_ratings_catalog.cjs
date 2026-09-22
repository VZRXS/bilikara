"use strict";
// Real desktop HTTP + typed Internet dispatch + rendered shared Host/LAN Remote.
// Played records are trusted synthetic storage, never evidence of media playback.
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const {spawn} = require("node:child_process"), {once} = require("node:events"), {createInterface} = require("node:readline");
const {randomUUID} = require("node:crypto"), {chromium, request} = require("playwright");
const evidence=path.resolve(process.argv[2]), control=process.env.CATALOG_FIXTURE_CONTROL;
const bvid="BV1xx411c7mD", url=`https://www.bilibili.com/video/${bvid}`;
const shutdown="synthetic-rating-shutdown";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(query) {return (await fetch(control+"/fixture/"+query)).json();}
async function stats() {return fixture("stats");}
async function until(fn, label) {for(let n=0;n<200;n++){if(await fn())return;await pause(25);}throw Error("Timed out: "+label);}
(async()=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),"native-ratings-catalog-"));
 const home=path.join(temporary,"native"),legacy=path.join(temporary,"legacy");
 let child, lines, browser, ready, stderr="";
 const played=Array.from({length:10},(_,i)=>({key:`played-${i}`,item_id:`played-${i}`,bvid,title:"Trusted played fixture",display_title:"Trusted played fixture",part_title:"on vocal",original_url:url,resolved_url:url,aid:123,cid:456,page:1,played_at:i+1}));
 await fs.mkdir(path.join(legacy,"data/played_sessions"),{recursive:true});
 await fs.writeFile(path.join(legacy,"data/session_users.json"),JSON.stringify({session_users:["Alice","Bob"]}));
 await fs.writeFile(path.join(legacy,"data/played_sessions/played-synthetic.json"),JSON.stringify({session_started_at:1,items:played}));
 await fs.writeFile(path.join(legacy,"data/playlist_backup.json"),JSON.stringify({current_item:null,playlist:[],played_session:{file:"played-synthetic.json",session_started_at:1},updated_at:12}));
 const http=await request.newContext();
 const api=async(route,body,cookie,method)=>{
  const r=await http.fetch(ready.baseUrl+route,{method:method||(body===undefined?"GET":"POST"),headers:{Cookie:cookie||""},...(body===undefined?{}:{data:body})});
  return {status:r.status(),body:await r.json()};
 };
 const okay=async(route,body,cookie)=>{const r=await api(route,body,cookie);assert.equal(r.status,200,route+": "+JSON.stringify(r.body));return r.body.data;};
 let hostCookie,remoteCookie;
 const rating=(id=0,user="Alice",score=4)=>({session_user_name:user,play_id:`played-${id}`,bvid,score});
 const postRating=(body,cookie=hostCookie)=>api("/api/rating/submit",body,cookie);
 const add=(body={},cookie=hostCookie)=>api("/api/playlist/add",{url,requester_name:"Alice",...body},cookie);
 let seq=0;const peer="rating-peer",epoch="abcdefghijklmnopqrstuv";
 const send=(kind,body={},profilePeer=peer)=>api("/api/internet-remote/dispatch",{peer_id:profilePeer,lane:"control",message:JSON.stringify({v:1,lane:"control",epoch,seq:++seq,id:randomUUID(),kind,body})},hostCookie);
 try {
  child=spawn(path.resolve("rust-runtime/target/debug/bilikara-desktop-host"),["--import-from",legacy,"--data-dir",home,"--static-dir",path.resolve("static"),"--port","0"],{env:{...process.env,BILIKARA_SHUTDOWN_TOKEN:shutdown},stdio:["ignore","pipe","pipe"]});
  child.stderr.on("data",d=>{stderr=(stderr+d).slice(-12000);});lines=createInterface({input:child.stdout});
  ready=JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(child,"exit").then(()=>{throw Error(stderr);})]));
  assert.equal(ready.backend,"rust");
  const bootstrap=await http.get(ready.bootstrapUrl);hostCookie=bootstrap.headers()["set-cookie"].split(";")[0];
  await okay("/api/session/startup-choice",{choice:"continue"},hostCookie);
  let state=await okay("/api/state",undefined,hostCookie);
  assert.equal(state.capabilities.song_rating,true);assert.equal(state.capabilities.catalog_write,false);assert.equal(state.capabilities.maintenance,false);
  assert.equal((await stats()).calls.length,0,"startup/imported played records must not upload");
  const remoteJoin=await http.get(state.remote_access.lan_urls[0].replace(/http:\/\/[^/]+/,ready.baseUrl));
  remoteCookie=remoteJoin.headers()["set-cookie"].split(";")[0];
  assert.equal((await postRating(rating(),remoteCookie)).status,403);
  await okay("/api/remote-identity/register",{name:"Remote"},remoteCookie);
  assert.equal((await postRating(rating(),"forged=cookie")).status,403);
  assert.equal((await postRating(rating(),"")).status,403);
  for(const patch of [{score:0},{score:6},{score:1.5},{play_id:"forged"},{bvid:"BV1xx411c7mE"},{session_user_name:"forged"}])assert.notEqual((await postRating({...rating(),...patch})).status,200);
  for(const [route,method] of [["/api/rating/submit","GET"],["/api/rating/submit","PUT"],["/api/rating/admin","POST"],["/api/app/update/finish","POST"],["/api/app/execute","POST"],["/api/admin-maintenance/trigger","POST"],["/api/bilikara-secret/verify","POST"]])assert.notEqual((await api(route,method==="GET"?undefined:{},hostCookie,method)).status,200,route);
  for(const route of ["/api/app/update/check","/api/cache-downloader/prepare","/api/internet-remote/peer/open"])assert.equal((await api(route,{download_source:"downkyi"},remoteCookie)).status,403,route);
  assert.equal((await stats()).calls.length,0);
  await fixture("control?rating=hold");
  let settled=false;const pending=postRating(rating()).then(r=>{settled=true;return r;});
  await until(async()=>(await stats()).calls.length===1,"rating reaches TLS fixture");
  assert.equal(settled,false,"no acceptance before service result");
  assert.equal((await postRating(rating())).body.code,"rating_pending");
  await okay("/api/state",undefined,hostCookie); // Network I/O releases AppState.
  await fixture("control?rating=release");assert.equal((await pending).body.data.success,true);
  assert.equal((await postRating(rating())).body.data.duplicate,true);assert.equal((await stats()).calls.length,1);
  for(const mode of ["http_failure","body_failure"]){
   await fixture(`control?rating_mode=${mode}`);
   const failed=await postRating(rating(1));assert.equal(failed.status,503);assert.equal(failed.body.code,"rating_unavailable");assert.ok(!JSON.stringify(failed).includes("fixture-private"));
  }
  await fixture("control?rating_mode=success");assert.equal((await postRating(rating(1))).body.data.success,true);
  assert.equal((await postRating(rating(2,"Alice"),remoteCookie)).status,200);
  assert.equal((await stats()).calls.at(-1).body.session_user_name,"Remote","Remote cannot select Alice");
  await okay("/api/remote-identity/rename",{name:"Renamed"},remoteCookie);
  assert.equal((await postRating(rating(2,"Bob"),remoteCookie)).body.data.duplicate,true);
  await okay("/api/internet-remote/peer/open",{peer_id:peer,epoch,profile:"controller"},hostCookie);
  assert.notEqual((await send("rating.submit",{play_id:"played-3",score:4})).status,200);
  assert.equal((await send("session.set_identity",{name:"Internet"})).status,200);
  assert.equal((await send("session.set_identity",{name:"Alice"})).status,200);
  const sharedBefore=(await stats()).calls.length;
  assert.equal((await send("rating.submit",{play_id:"played-0",score:5})).body.data.data.duplicate,true);
  assert.equal((await stats()).calls.length,sharedBefore,"HTTP and typed Remote share one ledger");
  assert.equal((await send("session.set_identity",{name:"Internet"})).status,200);
  const typed=await send("rating.submit",{play_id:"played-3",score:4});assert.equal(typed.body.data.data.success,true,JSON.stringify(typed));
  assert.equal((await send("rating.submit",{play_id:"played-3",score:2})).body.data.data.duplicate,true);
  for(const body of [{play_id:"forged",score:4},{play_id:"played-3",score:0},{play_id:"played-3",score:4,session_user_name:"Alice"}])assert.notEqual((await send("rating.submit",body)).status,200);
  await okay("/api/internet-remote/peer/open",{peer_id:"audience",epoch,profile:"viewer"},hostCookie);
  assert.notEqual((await send("rating.submit",{play_id:"played-3",score:4},"audience")).status,200);
  await fixture("control?rating_mode=http_failure");assert.equal((await send("rating.submit",{play_id:"played-4",score:4})).status,503);
  await fixture("control?rating_mode=success");assert.equal((await send("rating.submit",{play_id:"played-4",score:4})).body.data.data.success,true);
  // Login remains independent of Catalog publication.
  const beforeLogin=(await stats()).calls.length;
  await okay("/api/bbdown/login/start",{},hostCookie);
  await until(async()=>JSON.stringify((await okay("/api/state",undefined,hostCookie)).bbdown).includes('"logged_in":true'),"synthetic login");
  assert.equal((await stats()).calls.length,beforeLogin,"login must not upload libraries");
  const appendCount=async()=>(await stats()).calls.filter(c=>c.path==="/batch-add").length;
  const first=await add({title:"untrusted client title",cookie:"synthetic-client-secret",video_media_url:"private/media.mp4"});assert.equal(first.status,200,JSON.stringify(first));
  const current=first.body.data.current_item;assert.equal(current.requester_name,"Alice");
  await until(async()=>await appendCount()===1,"accepted add contributes");
  const record=(await stats()).calls.at(-1).body.records[0];
  assert.deepEqual(Object.keys(record).sort(),["mid","bvid","title","url","owner_name","owner_url","cover_url"].sort());
  assert.equal(record.bvid,current.bvid);assert.equal(record.title,current.title);assert.equal(record.mid,"42");
  assert.notEqual((await add()).status,200);assert.notEqual((await add({position:"bad",allow_repeat:true})).status,200);assert.equal(await appendCount(),1);
  await fixture("control?append_mode=http_failure");assert.equal((await add({allow_repeat:true},remoteCookie)).status,200);
  await until(async()=>await appendCount()===2,"Remote accepted add contributes despite refusal");
  assert.equal((await okay("/api/state",undefined,hostCookie)).playlist.at(-1).requester_name,"Renamed");
  await fixture("control?append_mode=success");
  let revision=(await okay("/api/internet-remote/state",undefined,hostCookie)).revision;
  const internetAdd=()=>send("playlist.add",{catalog_item_id:"BV1xx411c7mE_p1",position:"tail",allow_repeat:true,expected_revision:revision});
  const added=await internetAdd();assert.equal(added.body.data.accepted,true,JSON.stringify(added));
  await until(async()=>await appendCount()===3,"typed accepted add contributes");
  await fixture("control?metadata=hold");let metadata=(await stats()).counts.metadata;
  const late=internetAdd();await until(async()=>(await stats()).counts.metadata>metadata,"pending peer add");
  await okay("/api/internet-remote/peer/close",{peer_id:peer},hostCookie);
  await fixture("control?metadata=release");assert.notEqual((await late).status,200);assert.equal(await appendCount(),3);
  console.log("Desktop HTTP/typed ratings, identity, duplicates, retry, accepted-add and closed-peer checks: PASS");

  browser=await chromium.launch({headless:true,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toLowerCase().includes("proxy"))),...(process.env.BILIKARA_BROWSER_EXECUTABLE?{executablePath:process.env.BILIKARA_BROWSER_EXECUTABLE}:{}),args:["--disable-background-networking"]});
  const errors=[],summaries=[],consoleEvidence=[];
  for(const [role,cookie] of [["host",hostCookie],["remote",remoteCookie]]){
   const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
   await ctx.addCookies([{name:cookie.split("=")[0],value:cookie.slice(cookie.indexOf("=")+1),url:ready.baseUrl}]);
   await ctx.addInitScript(()=>localStorage.setItem("bilikara.update.automatic","false"));
   await ctx.route("**/*",r=>new URL(r.request().url()).hostname==="127.0.0.1"?r.continue():r.abort());
   const page=await ctx.newPage();page.on("pageerror",e=>errors.push(e.message));
   const logs=[];page.on("console",m=>{if(["error","warning"].includes(m.type()))logs.push(m.text());});
   await page.goto(ready.baseUrl+(role==="host"?"/":"/remote"));
   await page.waitForFunction(()=>!!state.data?.current_item);
   assert.equal(await page.title(),role==="host"?"bilikara host":"bilikara remote");
   if(role==="host") {
    await page.locator("#work-rail-request").click();
    // Use the actual selected requester control; no playback fixture needed.
    await page.selectOption("#requester-select","Bob");
    await page.locator("#work-rail-queue").click();
   }
   for(const width of [1440,412]){
    await page.setViewportSize({width,height:900});
    if(role==="host") {
     if(width===412)await page.locator('[data-android-page="queue"]').click();
     else if(!await page.locator("#open-rating-button").isVisible())await page.locator("#work-rail-queue").click();
    } else if(!await page.locator("#open-rating-button").isVisible())await page.locator("#playback-dock").click();
    await page.locator("#open-rating-button").click();
    await page.locator('.rating-modal:not(.closing) [data-rating-score="4"]').click();
    await page.locator('.rating-modal:not(.closing)').evaluate(async el=>{
      await Promise.all(el.getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));
    });
    await page.screenshot({path:path.join(evidence,`${role}-${width}-dialog.png`),mask:[page.locator(".remote-mini-control")]});
    await fixture("control?rating_mode=http_failure");
    const before=(await stats()).calls.filter(c=>c.path==="/rate-song").length;
    await page.locator('.rating-modal:not(.closing) .rating-actions [data-rating-close]').click();
    await until(async()=>(await stats()).calls.filter(c=>c.path==="/rate-song").length===before+1,"rendered submit");
    await page.waitForFunction(()=>state.ratingSubmittedKeys.size===0 && state.ratingPendingKeys.size===0);
    assert.equal(await page.locator("#open-rating-button").isEnabled(),true);
    await page.waitForFunction(()=>!document.querySelector(".rating-modal"));
    await page.screenshot({path:path.join(evidence,`${role}-${width}-retry.png`),mask:[page.locator(".remote-mini-control")]});
    summaries.push({role,width,failureRetry:true});
   }
   await fixture("control?rating_mode=success&rating=hold");
   await page.locator("#open-rating-button").click();
   await page.locator('.rating-modal:not(.closing) [data-rating-score="3"]').click();
   const before=(await stats()).calls.filter(c=>c.path==="/rate-song").length;
   const button=await page.locator('.rating-modal:not(.closing) .rating-actions [data-rating-close]').elementHandle();
   await button.click();assert.equal(await button.getAttribute("aria-busy"),"true");
   await until(async()=>(await stats()).calls.filter(c=>c.path==="/rate-song").length===before+1,"pending UI rating");
   const submittedPayload=(await stats()).calls.filter(c=>c.path==="/rate-song").at(-1).body;
   assert.equal(submittedPayload.session_user_name,role==="host"?"Bob":"Renamed");
   assert.equal(submittedPayload.score,3);
   assert.equal(await page.evaluate(()=>state.ratingSubmittedKeys.size),0,"pending UI is not rated");
   for(const width of [1440,412,1440,412]){await page.setViewportSize({width,height:900});await page.evaluate(()=>render());}
   assert.equal(await page.evaluate(()=>submitSongRating(state.data.current_item,5)),false);
   assert.equal((await stats()).calls.filter(c=>c.path==="/rate-song").length,before+1);
   await fixture("control?rating=release");await until(async()=>await button.getAttribute("aria-busy")===null,"busy restored");
   assert.equal(await page.evaluate(()=>hasSubmittedSongRating(state.data.current_item)),true);
   await page.screenshot({path:path.join(evidence,`${role}-accepted.png`),mask:[page.locator(".remote-mini-control")]});
   // Expected network failures are deliberately exercised; any script error fails.
   const unexpected=logs.filter(s=>!/(503|Rating submit failed|评分提交失败|video|media|Media|音频|缓存|ERR_FAILED)/.test(s));
   assert.deepEqual(unexpected,[],JSON.stringify(logs));
   consoleEvidence.push({role,expected:logs,unexpected});
   await ctx.close();
  }
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(evidence,"browser-summary.json"),JSON.stringify({passed:true,summaries,pageErrors:errors,consoleEvidence,playbackEvidence:false},null,2));
  // Saturate the existing bounded queue. No accepted local request rolls back.
  const beforeQueue=await appendCount();await fixture("control?append=hold");
  for(let i=0;i<70;i++)assert.equal((await add({allow_repeat:true})).status,200);
  assert.ok(stderr.includes("native catalog append could not be scheduled"),"full queue reported independently");
  assert.equal((await okay("/api/state",undefined,hostCookie)).playlist.length,72);
  await fixture("control?append=release");await until(async()=>await appendCount()===beforeQueue+65,"bounded queue drain");
  console.log("Rendered Host/Remote desktop + phone controls and bounded append queue: PASS");
  const stableAppends=await appendCount();
  await fixture("control?metadata=hold");metadata=(await stats()).counts.metadata;
  const removedOwner=add({allow_repeat:true},remoteCookie);
  await until(async()=>(await stats()).counts.metadata>metadata,"owner's delayed add");
  await okay("/api/session-users/remove",{name:"Renamed"},hostCookie);
  await fixture("control?metadata=release");assert.equal((await removedOwner).status,403);
  assert.equal(await appendCount(),stableAppends);
  await fixture("control?metadata=hold&rating=hold");metadata=(await stats()).counts.metadata;
  const changedSessionAdd=add({allow_repeat:true});
  const priorRatings=(await stats()).calls.length;
  const changedSessionRating=postRating(rating(5));
  await until(async()=>(await stats()).counts.metadata>metadata && (await stats()).calls.length>priorRatings,"session-bound pending I/O");
  await okay("/api/data/reset",{},hostCookie);
  await fixture("control?metadata=release&rating=release");
  assert.equal((await changedSessionAdd).body.code,"session_changed");
  assert.equal((await changedSessionRating).body.data.success,true,"already submitted Catalog work retains its result");
  assert.equal(await appendCount(),stableAppends);
  assert.equal((await postRating(rating(5),remoteCookie)).status,403);
  await okay("/api/session-users/add",{name:"Alice"},hostCookie);
  assert.equal((await postRating(rating(5))).body.code,"rating_stale");
  await fixture("control?metadata=hold");metadata=(await stats()).counts.metadata;
  const stoppedAdd=add();await until(async()=>(await stats()).counts.metadata>metadata,"stopped delayed add");
  const shutdownResponse=await fetch(ready.baseUrl+"/api/app/shutdown",{method:"POST",headers:{"x-bilikara-shutdown-token":shutdown}});
  assert.equal(shutdownResponse.status,200);await fixture("control?metadata=release");
  assert.equal((await stoppedAdd).body.code,"stopped");assert.equal(await appendCount(),stableAppends);
  if(child.exitCode===null)await once(child,"exit");
  console.log("Removed owner, changed session and stopped Host reject late adds without contributions: PASS");
 } finally {
  await fixture("control?rating=release&append=release&metadata=release");
  if(browser)await browser.close();
  if(child && child.exitCode===null){await fetch(ready.baseUrl+"/api/app/shutdown",{method:"POST",headers:{"x-bilikara-shutdown-token":shutdown}});await once(child,"exit");}
  if(child)assert.equal(child.exitCode,0,stderr);
  lines?.close();await http.dispose();await fs.rm(temporary,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
