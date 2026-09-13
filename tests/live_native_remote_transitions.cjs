"use strict";
// A passive Remote must follow a Host-originated song end without a refresh or
// a Remote mutation response masking a broken event stream.
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {once}=require("node:events");
const {createInterface}=require("node:readline");
const path=require("node:path");
const fs=require("node:fs/promises");
const {chromium}=require("playwright");
const [exe,directory,video,audio,executablePath,mode]=process.argv.slice(2);
(async()=>{
  await fs.mkdir(directory,{recursive:true});
  const server=spawn(exe,[path.resolve(directory),path.resolve("static"),path.resolve(video),path.resolve(audio)],{stdio:["pipe","pipe","pipe"]});
  server.stderr.on("data",()=>{});
  const lines=createInterface({input:server.stdout});let browser,host,remote;
  try {
    const bootstrap=JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error("Host exited before listening");})])).bootstrap_url;
    browser=await chromium.launch({headless:true,executablePath,args:["--autoplay-policy=no-user-gesture-required"]});
    const context=await browser.newContext({viewport:{width:1100,height:850}});
    await context.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
    host=await context.newPage();await host.goto(bootstrap);
    await host.waitForFunction(()=>state.data?.current_item?.id==="fixture-first" && document.querySelector("video")?.currentTime>0.3);
    const invite=await host.evaluate(()=>state.data.remote_access.local_url);
    const rc=await browser.newContext({viewport:{width:392,height:817},isMobile:true,hasTouch:true});
    if(mode==="silent-stream")await rc.addInitScript(()=>{
      const Original=window.EventSource;
      window.EventSource=class extends Original {
        addEventListener(type,listener,options) {
          return super.addEventListener(type,event=>{
            // The TCP connection remains open: neither data nor error reaches
            // the UI, as with a suspended/buffering mobile transport.
            if(window.blockedSource===this && ["state","heartbeat"].includes(type))return;
            listener.call(this,event);
          },options);
        }
      };
    });
    await rc.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
    remote=await rc.newPage();await remote.goto(invite);
    await remote.locator("#remote-identity-input").fill("Passive Remote");
    await remote.locator("#remote-identity-submit").click();
    await remote.waitForFunction(()=>state.remoteIdentity?.registered && state.eventStreamHealthy);
    await remote.evaluate(()=>{
      window.transitionEvents=[];
      state.eventSource.addEventListener("state",e=>{const s=JSON.parse(e.data);transitionEvents.push({id:s.current_item?.id,revision:s.state_revision});});
    });
    await remote.locator("#playback-dock").click();
    if(mode==="silent-stream")await remote.evaluate(()=>{window.blockedSource=state.eventSource;});
    // Seek close to the real media end, then let the normal ended -> next path run.
    await host.evaluate(()=>{
      for(const m of document.querySelectorAll("video,audio"))if(Number.isFinite(m.duration))m.currentTime=m.duration-0.5;
    });
    await host.waitForFunction(()=>state.data?.current_item?.id==="fixture-second",null,{timeout:20000});
    await remote.waitForFunction(()=>state.data?.current_item?.id==="fixture-second",null,{timeout:20000});
    await remote.waitForFunction(()=>document.querySelector("#current-title")?.textContent.includes("fixture 2"),null,{timeout:4000});
    await remote.waitForFunction(()=>state.eventStreamHealthy,null,{timeout:5000});
    assert.equal(await remote.evaluate(()=>state.eventStreamHealthy),true);
    if(mode==="silent-stream") {
      await host.waitForFunction(async()=>{
        const d=await fetch("/api/diagnostics/native").then(r=>r.json());
        return d.data?.remote_connection?.some(e=>e.event==="stale");
      });
    }
    console.log(JSON.stringify({passed:true,passiveRemoteNaturalEnd:true,mode,events:await remote.evaluate(()=>transitionEvents)}));
  } catch(e) {
    if(remote)console.log(JSON.stringify(await remote.evaluate(()=>({item:state.data?.current_item?.id,revision:state.data?.state_revision,
      title:document.querySelector("#current-title")?.textContent,healthy:state.eventStreamHealthy,events:window.transitionEvents})).catch(()=>({}))));
    throw e;
  } finally {
    if(browser)await browser.close();server.stdin.end("stop\n");lines.close();if(server.exitCode===null)await once(server,"exit");
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
