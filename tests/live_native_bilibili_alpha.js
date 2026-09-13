"use strict";
// Opt-in network acceptance, never part of unit tests and never contacts D1.
// EXE PRIVATE_DIR BV [CHROME]. The private directory must be disposable/empty.
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const http = require("node:http");
const path = require("node:path");
const {chromium} = require("playwright");
const [executable, directory, bvid, executablePath] = process.argv.slice(2);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  const server = spawn(executable, [path.resolve(directory), path.resolve("static")], {stdio: ["pipe", "pipe", "pipe"]});
  const lines = createInterface({input: server.stdout});
  let browser;
  try {
    const line = await Promise.race([
      once(lines,"line").then(value => value[0]),
      once(server,"exit").then(() => { throw new Error("Native harness exited before listening"); }),
    ]);
    const bootstrap = JSON.parse(line).bootstrap_url;
    const base = new URL(bootstrap).origin;
    // Use a document navigation, not fetch()'s cors request to a capability
    // endpoint. The fixture browser test covers actual Strict-cookie storage.
    const auth = await new Promise((resolve, reject) => {
      http.get(bootstrap, {headers: {"Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}}, response => {
        response.resume();
        resolve(response);
      }).on("error", reject);
    });
    assert.equal(auth.statusCode, 200);
    const cookie = auth.headers["set-cookie"][0].split(";")[0];
    async function post(route,body) {
      return (await fetch(base+route,{method:"POST",headers:{Cookie:cookie,"Content-Type":"application/json","X-Bilikara-Client":"network-smoke"},body:JSON.stringify(body)})).json();
    }
    async function snapshot() {return (await (await fetch(base+"/api/state",{headers:{Cookie:cookie}})).json()).data;}
    assert.equal((await post("/api/bbdown/login/start",{})).ok,true);
    let qrReady=false;
    for(let n=0;n<25;n++) {
      const login=(await snapshot()).bbdown.login;
      if(login.qr_image) {qrReady=true;break;}
      if(login.state==="failed") throw new Error(login.message);
      await pause(1000);
    }
    assert.equal(qrReady,true,"Bilibili login QR unavailable");
    await post("/api/bbdown/logout",{});
    await post("/api/session-users/add",{name:"Alpha Network Test"});
    let result=await post("/api/playlist/add",{url:bvid,requester_name:"Alpha Network Test"});
    if(result.code==="manual_binding_required") {
      const page=result.binding.preferred_page||result.binding.pages[0].page;
      result=await post("/api/playlist/add",{url:bvid,requester_name:"Alpha Network Test",selected_video_page:page,selected_audio_pages:[page]});
    }
    if(!result.ok) throw new Error(`Metadata: ${result.code}: ${result.error}`);
    let item;
    let prior="";
    for(let n=0;n<180;n++) {
      item=(await snapshot()).current_item;
      if(item.cache_status!==prior) {prior=item.cache_status;console.log(JSON.stringify({stage:prior}));}
      if(item.cache_status==="ready") break;
      if(item.cache_status==="failed") throw new Error(item.cache_message);
      await pause(1000);
    }
    assert.equal(item.cache_status,"ready","Native download did not finish in three minutes");
    browser=await chromium.launch({headless:true,executablePath,args:["--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage({viewport:{width:1000,height:700}});
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(bootstrap);
    await page.waitForFunction(()=>document.querySelector("video")?.currentTime>1 && document.querySelector("audio")?.currentTime>1,null,{timeout:25000});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,bvid,qrReady,nativeDownload:true,realBilibiliVideoAndAudioDecode:true,errors}));
  } catch(error) {
    console.error(String(error.message).replace(/https?:\/\/[^\s]+/g,"[URL]"));process.exitCode=1;
  } finally {
    if(browser)await browser.close();
    server.stdin.end("stop\n");lines.close();
    if(server.exitCode===null)await once(server,"exit");
  }
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});
