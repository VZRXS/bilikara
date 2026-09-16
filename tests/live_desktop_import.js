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
const os = require("node:os");
let directory, source, temporary, applicationPath, proxy, proxyUrl;
const blockedRequests = [];
const executable = path.resolve("rust-runtime/target/debug/bilikara-desktop-host");
const shutdownToken = "synthetic-desktop-shutdown";
let server, browser, lines, page, remote;
const errors = [];
let stderr = "";
async function launch() {
  server = spawn(executable, ["--import-from", source, "--data-dir", directory, "--static-dir", path.resolve("static"), "--port", "0", "--headless", "--no-browser"], {
    env: {...process.env, PATH: applicationPath, HOME: path.join(temporary,"home"),
      BB_DOWN_PATH:process.env.BILIKARA_BBDOWN_ACTIVE || path.join(temporary,"unavailable-BBDown"),
      BILIKARA_HOME:path.join(temporary,"unused-default-home"), BILIKARA_BILIBILI_COOKIE:"",
      HTTP_PROXY:proxyUrl, HTTPS_PROXY:proxyUrl, ALL_PROXY:proxyUrl,
      http_proxy:proxyUrl, https_proxy:proxyUrl, all_proxy:proxyUrl,
      NO_PROXY:"127.0.0.1,localhost", no_proxy:"127.0.0.1,localhost",
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
async function put(name, value) {
  const destination = path.join(source,name); await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.writeFile(destination,typeof value === "string" ? value : JSON.stringify(value));
}
function item(id) { return {id, original_url:"https://www.bilibili.com/video/BV1xx411c7mD",resolved_url:"https://www.bilibili.com/video/BV1xx411c7mD",bvid:"BV1xx411c7mD",aid:1,cid:2,page:1,title:"Imported desktop song",part_title:"P1",display_title:"Imported desktop song",cover_url:"",embed_url:"",requester_name:"Alice",available_pages:[1],available_cids:[2],available_durations:[90],available_parts:["P1"],selected_pages:[1],selected_cids:[2],selected_durations:[90],selected_parts:["P1"],cache_status:"ready",cache_progress:100,video_relative_path:"../../live-cache",video_media_url:"file:///live-cache",is_cached:true}; }
const played = {key:"fixture",item_id:"old",display_title:"Archived fixture song",title:"Archived fixture song",part_title:"P1",original_url:"https://www.bilibili.com/video/BV1xx411c7mD",resolved_url:"https://www.bilibili.com/video/BV1xx411c7mD",bvid:"BV1xx411c7mD",aid:1,cid:2,page:1,played_at:101,ended_at:102,requester_name:"Alice"};
async function sourceBytes() {
  const files = await fs.readdir(source,{recursive:true}); const entries=[];
  for (const name of files.sort()) if ((await fs.lstat(path.join(source,name))).isFile()) entries.push([name,(await fs.readFile(path.join(source,name))).toString("base64")]);
  return entries;
}
async function openHost(ready) {
  const host=await browser.newContext({viewport:{width:1440,height:1000}}); page=await host.newPage();
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(ready.bootstrapUrl);await page.waitForURL(ready.baseUrl+"/");
  await page.waitForFunction(()=>state.data?.session_flags?.startup_choice_pending===true);
  assert.equal(await page.locator("html").getAttribute("data-host-platform"),"desktop");
  assert.equal(await page.locator("#android-host-dock").isVisible(),false);
  await page.locator('[data-session-choice="continue"]').click();
  await page.waitForFunction(()=>state.data?.session_flags?.startup_choice_pending===false);
  return host;
}
(async () => {
  await fs.mkdir(evidence,{recursive:true}); temporary=await fs.mkdtemp(path.join(os.tmpdir(),"desktop-import-browser-"));
  source=path.join(temporary,"legacy");directory=path.join(temporary,"native");applicationPath=path.join(temporary,"empty-path");await fs.mkdir(applicationPath);
  await put("data/player_state.json",{playback_mode:"local",player_settings:{global_av_delay_ms:320,av_delay_locked:true,volume_percent:55,is_muted:true,key_shift:2}});
  await put("data/session_users.json",{session_users:["Alice","Bob"]});
  await put("data/history.json",{history:[{key:"fixture",display_title:"History fixture song",original_url:played.original_url,resolved_url:played.resolved_url,requested_at:101,request_count:2}]});
  await put("data/played_sessions/played-current.json",{session_started_at:100,items:[played]});
  await put("data/played_sessions/played-archive.json",{session_started_at:50,items:[played]});
  await put("data/playlist_backup.json",{current_item:item("current"),playlist:[item("queued"),item("remove-me")],played_session:{file:"played-current.json",session_started_at:100},updated_at:103});
  await put("data/cache_policy.json",{download_source:"bbdown",max_cache_items:4,audio_hires:true,reset_offset_on_next:true,future_option:"keep"});
  await put("data/gatcha_uids.json",{uids:["123"],profiles:{}});
  await put("data/gatcha_favlist.json",{uid:"456",folders:[{id:"7",title:"Saved folder"}],items:[]});
  await put("data/gatcha_pool_config.json",{uid_weight:30,favlist_weight:70,excluded_uids:["123"]});
  await put("tools/bbdown/BBDown.data","SESSDATA=synthetic-import; bili_jct=synthetic-csrf; DedeUserID=123");
  await put("data/cache/source-only.txt","Never copied or deleted");
  const original=await sourceBytes();
  const missingArgument=require("node:child_process").spawnSync(executable,["--data-dir",directory,"--static-dir",path.resolve("static"),"--import-from"],{encoding:"utf8"});
  assert.equal(missingArgument.status,1);await assert.rejects(fs.stat(directory));
  proxy=require("node:http").createServer((request,response)=>{blockedRequests.push(request.method);response.writeHead(503);response.end();});
  proxy.on("connect",(request,socket)=>{blockedRequests.push("CONNECT");socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");});
  proxy.listen(0,"127.0.0.1");await once(proxy,"listening");proxyUrl=(process.env.BILIKARA_CACHE_POLICY_FIXTURE || process.env.BILIKARA_BBDOWN_FIXTURE) ? process.env.HTTPS_PROXY : `http://127.0.0.1:${proxy.address().port}`;
  let ready=await launch();
  const unauthenticated = await fetch(ready.baseUrl+"/api/state");
  assert.equal(unauthenticated.status,403);
  browser=await webkit.launch({headless:true,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toLowerCase().includes("proxy")))});
  let host=await openHost(ready);let initial=await okay("/api/state");
  assert.equal(initial.current_item.id,"current");assert.equal(initial.current_item.cache_status,"pending");assert.match(initial.current_item.cache_message,/unavailable/);
  assert.equal(initial.current_item.video_media_url,"");assert.equal(initial.current_item.video_relative_path,"");assert.deepEqual(initial.playlist.map(v=>v.id),["queued","remove-me"]);
  assert.deepEqual(initial.session_users,["Alice","Bob"]);assert.equal(initial.history.length,1);assert.equal(initial.session_played.length,1);
  assert.equal(initial.bbdown.logged_in,true);assert.equal(initial.cache_policy.download_source,"bbdown");assert.equal(initial.cache_policy.enabled,false);
  assert.equal(initial.bbdown.ready,false);assert.ok(!JSON.stringify(initial).includes("synthetic-import"));
  assert.equal(initial.cache_policy.download_source_choices.find(v=>v.value==="bbdown").label,"bbdown (unavailable in Desktop Rust)");
  const unsupported=await api("/api/cache/retry",{item_id:"current",expected_item_incarnation_id:initial.current_item.item_incarnation_id});
  assert.equal(unsupported.status,501);assert.equal(unsupported.body.code,"imported_cache_policy_unavailable");
  assert.deepEqual((await okay("/api/gatcha/uids")).uids,["123"]);
  await okay("/api/gatcha/pool-config",{uid_weight:40});
  assert.equal((await okay("/api/gatcha/pool-config")).uid_weight,40);
  const sessions=await okay("/api/played-sessions");assert.equal(sessions.length,1);assert.equal(sessions[0].id,"played-archive.json");
  for (const sourceName of ["played-archive.json","played","history"]) {
    for (const format of ["csv","image"]) {
      const response=await host.request.get(ready.baseUrl+`/api/playlist/export?format=${format}&source=${sourceName}&page_size=50`);
      assert.equal(response.status(),200);const bytes=await response.body();
      if (format==="csv") assert.ok(bytes.toString("utf8").includes("fixture song"));
      else assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
      await fs.writeFile(path.join(evidence,`${sourceName}.${format==="csv"?"csv":"png"}`),bytes);
    }
  }
  await page.locator("#work-rail-request").click();await capture("desktop-imported.png",page);
  await okay("/api/playlist/remove",{item_id:"remove-me"});
  await okay("/api/player/volume",{volume_percent:37});
  await okay("/api/session-users/reorder",{name:"Bob",index:0});
  await okay("/api/ui-language",{language:"en"});
  let changed=await okay("/api/state");
  assert.deepEqual(changed.playlist.map(v=>v.id),["queued"]);assert.equal(changed.player_settings.volume_percent,37);
  assert.deepEqual(changed.session_users,["Bob","Alice"]);
  await capture("desktop-mutated.png",page);await host.close();await stop(ready);
  assert.deepEqual(await sourceBytes(),original);
  assert.equal((await fs.readdir(directory)).includes("cache"),false);
  const preferences=JSON.parse(await fs.readFile(path.join(directory,"native-preferences.json"),"utf8"));assert.equal(preferences.cache.retained_settings.cache_policy.future_option,"keep");
  // No second import is possible: restart receives the original, now absent path.
  await fs.rename(source,source+"-preserved");
  ready=await launch();host=await openHost(ready);const restored=await okay("/api/state");
  assert.equal(restored.current_item.id,"current");assert.notEqual(restored.current_item.item_incarnation_id,initial.current_item.item_incarnation_id);
  assert.deepEqual(restored.playlist.map(v=>v.id),["queued"]);assert.equal(restored.player_settings.volume_percent,37);
  assert.deepEqual(restored.session_users,["Bob","Alice"]);assert.deepEqual(restored.history,changed.history);assert.deepEqual(restored.session_played,changed.session_played);
  assert.equal((await okay("/api/played-sessions")).length,1);assert.equal((await okay("/api/ui-language")).language,"en");
  assert.equal((await okay("/api/gatcha/pool-config")).uid_weight,40);assert.equal(restored.bbdown.logged_in,true);
  assert.equal(restored.cache_policy.download_source,"bbdown");
  await page.waitForFunction(()=>document.body.innerText.includes("Imported desktop song"));
  await capture("desktop-restarted.png",page);
  if(process.env.BILIKARA_CACHE_POLICY_FIXTURE) {
    await require("./desktop_cache_policy_case.js")({api,okay,capture,browser,evidence,directory,getPage:()=>page,
      restart:async(beforeNavigate)=>{await host.close();await stop(ready);ready=await launch();if(beforeNavigate)await beforeNavigate(ready);host=await openHost(ready);},
      inspectPersisted:()=>fs.readFile(path.join(directory,"native-preferences.json"),"utf8")});
  }
  if(process.env.BILIKARA_BBDOWN_FIXTURE) {
    await require("./desktop_bbdown_case.js")({api,okay,capture,browser,evidence,directory,getPage:()=>page,
      restart:async()=>{if(server.exitCode===null){await host.close();await stop(ready);}ready=await launch();host=await openHost(ready);},
      shutdown:async()=>{await host.close();await stop(ready);},getPid:()=>server.pid});
    // The case verifies active-child shutdown and restarts for the common receipt.
  }
  await host.close();await stop(ready);
  source+="-preserved";assert.deepEqual(await sourceBytes(),original);
  assert.deepEqual(errors,[]);assert.deepEqual(blockedRequests,[],"Import/restart must not trigger remote catalog, credential or media requests");
  await fs.writeFile(path.join(evidence,"import-summary.json"),JSON.stringify({passed:true,actualRustEntry:true,pythonBackend:false,applicationPathEmpty:true,sourceBytesUnchanged:true,imports:1,restarts:1,queueMutation:true,settingsMutation:true,credentialRestored:true,archives:true,exports:["csv","png"],unavailableSource:"bbdown",reimportSkippedWithAbsentSource:true,pageErrors:errors,externalRequests:blockedRequests.length},null,2));
  console.log("Actual desktop import, exports, native mutations and no-reimport restart passed");
})().catch(async error=>{console.error(error,stderr);if(process.env.BILIKARA_BBDOWN_FIXTURE){
    if(page)await fs.writeFile(path.join(evidence,"failure-state.json"),JSON.stringify(await api("/api/state"),null,2)).catch(()=>{});
    await fs.copyFile(path.join(directory,"logs/native-cache.log"),path.join(evidence,"failure-cache.log")).catch(()=>{});
    const fixtureRoot=process.env.BILIKARA_BBDOWN_FIXTURE_ROOT;
    if(fixtureRoot)for(const file of await fs.readdir(fixtureRoot))if(file.endsWith(".started"))await fs.copyFile(path.join(fixtureRoot,file),path.join(evidence,file));
  }if(page)await capture("failure.png",page).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server?.exitCode===null){server.kill("SIGTERM");await once(server,"exit");}if(proxy)proxy.close();if(temporary)await fs.rm(temporary,{recursive:true,force:true});});
