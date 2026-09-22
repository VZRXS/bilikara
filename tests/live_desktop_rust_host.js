"use strict";
// Exercise the executable desktop entry, never the alpha seeding example.
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const {webkit} = require("playwright");
const evidence = path.resolve(process.argv[2]);
const directory = path.join(evidence, "preview");
const executable = path.resolve("rust-runtime/target/debug/bilikara-desktop-host");
const shutdownToken = "synthetic-desktop-shutdown";
let server, browser, lines, page, remote;
const errors = [];
let stderr = "";
async function launch() {
  server = spawn(executable, ["--data-dir", directory, "--static-dir", path.resolve("static"), "--port", "0", "--headless", "--no-browser"], {
    env: {...process.env, PATH: process.env.BILIKARA_TEST_APPLICATION_PATH ?? process.env.PATH,
      BILIKARA_SHUTDOWN_TOKEN: shutdownToken}, stdio: ["ignore", "pipe", "pipe"]});
  server.stderr.on("data", v => { stderr = (stderr + v).slice(-4000); });
  lines = createInterface({input: server.stdout});
  const ready = JSON.parse(await Promise.race([once(lines, "line").then(v => v[0]), once(server,"exit").then(() => {throw Error("Desktop entry exited before readiness: " + stderr);})]));
  assert.equal(ready.event, "bilikara.ready"); assert.equal(ready.backend,"rust");
  assert.equal(await fs.readlink(`/proc/${server.pid}/exe`), executable);
  // Child has no Python worker and has not loaded a Python runtime/cdylib.
  assert.equal((await fs.readFile(`/proc/${server.pid}/task/${server.pid}/children`,"utf8")).trim(), "");
  const maps = await fs.readFile(`/proc/${server.pid}/maps`,"utf8");
  assert.ok(!/libpython|libbilikara_runtime\.so/.test(maps));
  return ready;
}
async function stop(ready) {
  const response = await fetch(ready.baseUrl + "/api/app/shutdown", {method:"POST",headers:{"x-bilikara-shutdown-token":shutdownToken}});
  assert.equal(response.status,200);
  if (server.exitCode === null) await once(server,"exit");
  assert.equal(server.exitCode,0,stderr);
  await assert.rejects(fetch(ready.baseUrl + "/api/health"));
  lines.close();
}
async function api(route, body) {
  return page.evaluate(async ({route,body}) => {
    const response = await fetch(route, {method:body===undefined?"GET":"POST",headers:{...clientHeaders(),"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status, body:await response.json()};
  }, {route,body});
}
async function okay(route,body) {const r=await api(route,body);assert.equal(r.status,200,route+": "+JSON.stringify(r.body));return r.body.data;}
async function capture(name, target) {
  // Hide invitation/QR surfaces, even though these are disposable credentials.
  await target.screenshot({path:path.join(evidence,name),mask:[target.locator(".remote-mini-control"),target.locator(".remote-access-popover:visible"),target.locator("#remote-qr-content:visible")]});
}
(async () => {
  await fs.mkdir(evidence,{recursive:true});
  let ready=await launch();
  browser=await webkit.launch({headless:true,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toLowerCase().includes("proxy")))});
  let host=await browser.newContext({viewport:{width:1440,height:1000}});
  page=await host.newPage();
  page.on("pageerror",e=>errors.push(e.message));
  page.on("console", m=>{if(m.type()==="error" && !/status of (409|501)/.test(m.text()))errors.push(m.text().replace(/https?:\/\/\S+/g,"[URL]"));});
  await page.goto(ready.bootstrapUrl);
  await page.waitForURL(ready.baseUrl+"/");
  await page.waitForFunction(()=>state.hasValidStateResponse);
  assert.equal(await page.title(),"bilikara host");
  assert.equal(await page.locator("html").getAttribute("data-host-platform"),"desktop");
  assert.equal(await page.evaluate(()=>Boolean(window.BilikaraAndroidHost || window.BilikaraAndroidExport || window.BilikaraAndroidPlatform || window.BilikaraAndroidPlayback)),false);
  assert.equal(await page.locator("#android-host-dock").isVisible(),false);
  assert.equal(await page.evaluate(()=>BilikaraHostLayout.isPortrait()),false);
  assert.equal((await okay("/api/state")).capabilities.native_android_beta,false);
  await page.locator("#work-rail-users").click();
  await page.locator("#session-user-input").fill("Desktop Fixture");
  await page.locator("#session-user-form button[type=submit]").click();
  await page.waitForFunction(()=>state.data.session_users.includes("Desktop Fixture"));
  await okay("/api/bbdown/login/start",{});
  await page.waitForFunction(()=>state.data?.bbdown?.logged_in===true,null,{timeout:20000});
  const savedCookie=await fs.readFile(path.join(directory,"BBDown.data"),"utf8");
  assert.ok(savedCookie.includes("b_nut="));
  assert.ok(!JSON.stringify(await okay("/api/state")).includes("synthetic-session"));
  await page.locator("#work-rail-request").click();
  await page.locator("#url-input").fill("https://www.bilibili.com/video/BV1xx411c7mD");
  await page.locator("#add-form button[type=submit]").click();
  await page.waitForFunction(()=>state.data?.current_item?.cache_status==="ready",null,{timeout:45000});
  await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.3 || document.querySelector(".split-playback-start-overlay:not(.hidden)"),null,{timeout:20000});
  if(await page.locator(".split-playback-start-button").isVisible()) await page.locator(".split-playback-start-button").click();
  console.log("playback start interaction done");
  await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.3,null,{timeout:20000});
  console.log("login, automatic binding, native cache and playback passed");
  const first=await okay("/api/state");
  assert.equal(first.current_item.selected_pages.length,2);
  const manual=await api("/api/playlist/add",{url:"https://www.bilibili.com/video/BV1xx411c7mE",requester_name:"Desktop Fixture"});
  assert.equal(manual.status,409);assert.equal(manual.body.code,"manual_binding_required");
  await okay("/api/playlist/add",{url:"https://www.bilibili.com/video/BV1xx411c7mE",requester_name:"Desktop Fixture",selected_video_page:1,selected_audio_pages:[1,2]});
  console.log("manual binding passed");
  const second=(await okay("/api/state")).playlist[0].id;
  const remoteContext=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
  remote=await remoteContext.newPage();remote.on("pageerror",e=>errors.push(e.message));
  const lanInvite=first.remote_access.lan_urls[0];
  assert.ok(lanInvite,"A LAN interface is required for this local check");
  await remote.goto(lanInvite);
  await remote.waitForURL(new URL("/remote",lanInvite).href);
  await remote.locator("#remote-identity-input").fill("Remote Fixture");
  await remote.locator("#remote-identity-submit").click();
  await remote.waitForFunction(()=>document.querySelector("#remote-identity-modal").classList.contains("hidden"));
  assert.equal((await remoteContext.request.post(new URL("/api/app/update/check",lanInvite).href,{data:{}})).status(),403);
  await remote.locator("#playback-dock").click();
  await remote.locator('[data-control-action="toggle-play"]').click();
  await page.waitForFunction(()=>document.querySelector("video")?.paused===true);
  await remote.locator('[data-control-action="toggle-play"]').click();
  await page.waitForFunction(()=>document.querySelector("video")?.paused===false);
  const before=await page.evaluate(()=>document.querySelector("video").currentTime);
  await remote.locator('[data-control-action="seek-relative"][data-delta="15"]').click();
  await page.waitForFunction(v=>document.querySelector("video").currentTime>v+10,before);
  const variantToggle=remote.locator('[data-action="toggle-audio-variants"]');
  // Short variant lists use the existing inline buttons; only overflow needs
  // the popover. In either layout, perform and verify the actual track change.
  if(await variantToggle.isVisible()) await variantToggle.click();
  else assert.match(await remote.locator("#audio-variant-bar").getAttribute("class"),/\bis-inline\b/);
  const variant=first.current_item.audio_variants[1].id;
  await remote.locator(`[data-variant-id="${variant}"]`).click();
  await page.waitForFunction(id=>state.data.current_item.selected_audio_variant_id===id,variant);
  // Metadata network work must not own AppState while controls are in flight.
  const delayed=okay("/api/playlist/add",{url:"https://www.bilibili.com/video/BV1xx411c7mF",requester_name:"Desktop Fixture"});
  for(let n=0;n<100;n++) {if((await (await fetch(process.env.DESKTOP_FIXTURE_CONTROL+"/fixture/delayed")).json()).started)break;await new Promise(r=>setTimeout(r,30));}
  // Reuse the dedicated protocol envelope from live_native_beta_internet.
  const peer_id="desktop-protocol-fixture",epoch="abcdefghijklmnopqrstuv";
  await okay("/api/internet-remote/peer/open",{peer_id,epoch,profile:"controller"});
  let seq=0;
  const send=async(kind,body,lane="control")=>okay("/api/internet-remote/dispatch",{
    peer_id,lane,message:JSON.stringify({v:1,lane,epoch,seq:++seq,id:require("node:crypto").randomUUID(),kind,body})});
  assert.equal((await send("session.set_identity",{name:"Internet Fixture"})).accepted,true);
  const targetState=await okay("/api/state");
  const target={item_id:targetState.current_item.id,playback_generation:targetState.playback_generation};
  // Real LAN HTTP and dedicated Internet protocol against the SAME Host.
  // Ordered delivery/ACK is consumed by the unmodified shared player.
  let releaseAcks;
  const ackGate=new Promise(resolve=>{releaseAcks=resolve;});
  await page.route("**/api/player/control-ack",async route=>{await ackGate;await route.continue();});
  const position=await page.evaluate(()=>document.querySelector("video").currentTime);
  const both=await Promise.all([
    remote.evaluate(async target=>{const r=await fetch("/api/player/control",{method:"POST",headers:{...clientHeaders(),"content-type":"application/json"},body:JSON.stringify({...target,action:"seek-relative",delta_seconds:7})});return r.ok;},target),
    send("playback.seek_relative",{...target,delta_seconds:11})]);
  assert.equal(both[0],true);assert.equal(both[1].accepted,true);
  const head=(await okay("/api/state")).player_control_command;
  assert.ok(head);
  // Bypass only the browser's ACK barrier, still using the real HTTP route.
  const wrongAck=await host.request.post(ready.baseUrl+"/api/player/control-ack",{data:{seq:head.seq+1}});
  assert.equal(wrongAck.status(),200); // Compatibility response; false ACK is a no-op.
  assert.equal((await okay("/api/state")).player_control_command.seq,head.seq,"Out-of-order ACK removed the FIFO head");
  releaseAcks();
  await page.unroute("**/api/player/control-ack");
  await page.waitForFunction(v=>document.querySelector("video").currentTime>=v+17.5,position);
  console.log("LAN + Internet protocol relative seeks and delayed metadata controls passed");
  const start=Date.now();await okay("/api/player/volume",{volume_percent:55});assert.ok(Date.now()-start<1500);
  await fetch(process.env.DESKTOP_FIXTURE_CONTROL+"/fixture/release");await delayed;
  await capture("desktop-playing.png",page);await capture("remote-375x812.png",remote);
  await remote.evaluate(()=>sendPlayerNext());
  await page.waitForFunction(id=>state.data.current_item?.id===id,second);
  await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.3,null,{timeout:25000});
  const stale=await api("/api/player/next",{playback_generation:first.playback_generation});assert.equal(stale.status,409);
  assert.equal((await send("playback.next",{playback_generation:first.playback_generation})).accepted,false);
  await okay("/api/internet-remote/peer/close",{peer_id});
  for(const format of ["csv","image"]) {
    const response=await host.request.get(ready.baseUrl+`/api/playlist/export?format=${format}&source=history&page_size=50`);
    assert.equal(response.status(),200);const bytes=await response.body();
    assert.ok(format==="csv"?bytes.subarray(0,3).equals(Buffer.from([239,187,191])):bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    await fs.writeFile(path.join(evidence,`history.${format==="csv"?"csv":"png"}`),bytes);
  }
  const download=page.waitForEvent("download");
  await page.evaluate(()=>downloadHistoryExport("csv","history",50));
  assert.ok((await download).suggestedFilename().endsWith(".csv"));
  await capture("desktop-queue.png",page);
  // Real history records through the metadata/add route, enough to exercise ZIP.
  for(let n=0;n<51;n++) await okay("/api/playlist/add",{url:`https://www.bilibili.com/video/BV1xx411c7${String(n).padStart(2,"0")}`,requester_name:"Desktop Fixture"});
  let queue=await okay("/api/state");
  for(let n=0;n<51;n++) queue=await okay("/api/player/next",{playback_generation:queue.playback_generation});
  const zip=await host.request.get(ready.baseUrl+"/api/playlist/export?format=image&source=played&page_size=50");
  assert.equal(zip.status(),200);assert.equal(zip.headers()["content-type"],"application/zip");
  const zipBytes=await zip.body();assert.equal(zipBytes.subarray(0,4).toString("hex"),"504b0304");
  await fs.writeFile(path.join(evidence,"history.zip"),zipBytes);
  console.log("CSV, PNG, ZIP and browser download passed");
  const catalog=await okay("/api/catalog/search?q=desktop-fixture&limit=20");
  assert.equal(catalog.items[0].bvid,"BV1xx411c7mD");
  // Check-only desktop updates: a real request reaches the shared release
  // decision through the trusted-source fallback and installs nothing.
  assert.equal((await host.request.post(ready.baseUrl+"/api/app/update/check",{data:{}})).status(),400);
  const checked=await okay("/api/app/update/check",{include_preview:false});
  assert.equal(checked.state,"available");
  assert.equal(checked.update_action,"normal_upgrade");
  assert.equal(checked.current_version,"0.8.0");
  assert.equal(checked.latest_version,"v0.8.1");
  assert.equal(checked.include_preview,false);
  assert.equal(checked.eligible_update,true);
  // Linux ships no desktop package, and this Host could not install one anyway.
  assert.equal(checked.asset_available,false);
  assert.equal(checked.auto_update_supported,false);
  assert.equal(checked.platform_auto_update_supported,false);
  assert.deepEqual((await api("/api/app/update/status")).body.data,checked);
  assert.deepEqual((await okay("/api/state")).app_update,checked);
  await page.waitForFunction(()=>state.data?.app_update?.state==="available");
  assert.match(await page.locator("#update-check-button").textContent(),/v0\.8\.1/);
  // Known unsupported actions report unavailable rather than fake readiness.
  // The shared Host cookie does not carry the shell's private install capability.
  assert.equal((await host.request.post(ready.baseUrl+"/api/app/update/install",{data:{include_preview:false}})).status(),403);
  for(const route of ["/api/app/update/finish","/api/rating/submit"])
    assert.equal((await api(route,{include_preview:false})).status,501,route);
  await remoteContext.close(); await host.close();
  await stop(ready);
  ready=await launch(); host=await browser.newContext({viewport:{width:1440,height:1000}}); page=await host.newPage();
  page.on("pageerror",e=>errors.push(e.message));
  page.on("console",m=>{if(m.type()==="error" && !/status of (409|501)/.test(m.text()))errors.push(m.text().replace(/https?:\/\/\S+/g,"[URL]"));});
  await page.goto(ready.bootstrapUrl);await page.waitForURL(ready.baseUrl+"/");
  await page.waitForFunction(()=>state.data?.session_flags?.startup_choice_pending===true);
  await page.locator('[data-session-choice="continue"]').click();
  await page.waitForFunction(()=>state.data?.session_flags?.startup_choice_pending===false);
  assert.ok((await okay("/api/state")).session_played.length>=51);
  assert.equal(await fs.readFile(path.join(directory,"BBDown.data"),"utf8"),savedCookie);
  await okay("/api/bbdown/logout",{});await fetch(process.env.DESKTOP_FIXTURE_CONTROL+"/fixture/login-wait");
  await okay("/api/bbdown/login/start",{});
  const auth=(await host.cookies(ready.baseUrl)).find(c=>c.name==="bilikara_native");
  const pending=require("node:net").connect(new URL(ready.baseUrl).port,"127.0.0.1");pending.on("error",()=>{});
  await once(pending,"connect");
  pending.write(`POST /api/session-users/add HTTP/1.1\r\nHost: ${new URL(ready.baseUrl).host}\r\nCookie: bilikara_native=${auth.value}\r\nContent-Type: application/json\r\nContent-Length: 10000\r\n\r\n{`);
  await host.close();const stopping=Date.now();await stop(ready);assert.ok(Date.now()-stopping<5000);pending.destroy();
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(evidence,"browser-summary.json"),JSON.stringify({passed:true,entry:"bilikara-desktop-host",pythonBackend:false,desktop:[1440,1000],remote:[375,812],login:true,binding:["automatic","manual"],nativeCache:true,playback:true,seek:true,trackSwitch:true,next:true,staleNext:true,metadataConcurrency:true,exports:["csv","png","zip"],lanHttp:true,internetProtocolSimulation:true,realDataChannel:false,physicalCrossNetwork:false,restartRestore:true,inFlightLoginCancellation:true,fifoHeadAck:true,consoleErrors:errors},null,2));
  console.log("Desktop Rust entry/browser core loop passed (synthetic offline fixtures).");
})().catch(async e=>{console.error(e.message.replace(/https?:\/\/\S+/g,"[URL]"));if(page){console.error(await page.evaluate(()=>({video:(()=>{const v=document.querySelector("video");return v?{time:v.currentTime,ready:v.readyState,paused:v.paused,error:v.error?.message}:null})(),audio:(()=>{const v=document.querySelector("audio");return v?{time:v.currentTime,ready:v.readyState,paused:v.paused,error:v.error?.message}:null})(),session:state.hostPlaybackSession?{phase:state.hostPlaybackSession.phase,ready:state.hostPlaybackSession.readyCommitted,claim:state.hostPlaybackSession.ownershipClaimed,intent:state.hostPlaybackSession.logicalPlayIntent}:null,start:state.localPlaybackStartState,diagnostics:state.data?.diagnostics,message:state.data?.current_item?.cache_message,toast:document.querySelector("#app-toast")?.textContent})).catch(()=>({})));await capture("failure.png",page).catch(()=>{});}console.error(errors,stderr);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server?.exitCode===null){server.kill("SIGTERM");await once(server,"exit");}});
