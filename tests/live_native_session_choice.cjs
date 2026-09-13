"use strict";
// Offline process restarts, real modal actions and Host-only authorization.
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {once}=require("node:events");
const {createInterface}=require("node:readline");
const fs=require("node:fs/promises");
const path=require("node:path");
const {chromium}=require("playwright");
const [exe,directory,executablePath]=process.argv.slice(2);
(async()=>{
  await fs.mkdir(directory,{recursive:true});
  const browser=await chromium.launch({headless:true,executablePath});
  let server,lines,context,host;
  async function stop() {
    if(context)await context.close();
    if(server){server.stdin.end("stop\n");lines.close();if(server.exitCode===null)await once(server,"exit");server=null;}
  }
  async function boot() {
    server=spawn(exe,[path.resolve(directory),path.resolve("static")],{stdio:["pipe","pipe","pipe"]});
    server.stderr.on("data",()=>{});lines=createInterface({input:server.stdout});
    const url=JSON.parse((await once(lines,"line"))[0]).bootstrap_url;
    context=await browser.newContext({viewport:{width:392,height:817},locale:"zh-CN",isMobile:true,hasTouch:true});
    await context.addInitScript(()=>Object.defineProperty(screen.orientation,"type",{configurable:true,get:()=>"portrait-primary"}));
    await context.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1"?route.continue():route.abort());
    host=await context.newPage();await host.goto(url);
    host.on("pageerror",error=>console.error("UI error:",error.message));
    await host.waitForFunction(()=>state.data?.session_flags);
  }
  try {
    await boot();
    assert.equal(await host.locator("#android-session-choice").isVisible(),false);
    await host.evaluate(()=>apiPostStateSnapshot("/api/session-users/add",{name:"Saved singer"}));
    await stop();await boot();
    await host.locator("#android-session-choice").waitFor({state:"visible"});
    await host.keyboard.press("Escape");
    assert.equal(await host.locator("#android-session-choice").isVisible(),true);
    assert.equal(await host.evaluate(async()=>{
      const r=await fetch("/api/session-users/add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Must not enter old session"})});return r.status;
    }),409);
    await host.locator('[data-session-choice="continue"]').click();
    await host.waitForFunction(()=>!state.data.session_flags.startup_choice_pending);
    assert.deepEqual(await host.evaluate(()=>state.data.session_users),["Saved singer"]);
    await host.reload();await host.waitForFunction(()=>state.data?.session_flags);
    assert.equal(await host.locator("#android-session-choice").isVisible(),false);
    await stop();await boot();
    await host.locator('[data-session-choice="new"]').click();
    await host.waitForFunction(()=>!state.data.session_flags.startup_choice_pending);
    assert.deepEqual(await host.evaluate(()=>state.data.session_users),[]);
    await host.evaluate(()=>apiPostStateSnapshot("/api/session-users/add",{name:"New singer"}));
    // A retry of the resolved command cannot delete freshly added singers.
    await host.evaluate(()=>apiPostStateSnapshot("/api/session/startup-choice",{choice:"new"}));
    assert.deepEqual(await host.evaluate(()=>state.data.session_users),["New singer"]);
    await host.locator('[data-android-page="users"]').tap();
    await host.locator("#session-user-input").fill("Tap singer");
    await host.locator("#session-user-form button").tap();
    const badge=host.locator('.session-user-badge[data-name="Tap singer"]');
    assert.equal(await badge.getAttribute("draggable"),"false");
    await badge.locator(".android-user-toggle").tap();
    await badge.locator('[data-user-action="up"]').tap();
    await host.waitForFunction(()=>state.data.session_users[0]==="Tap singer");
    const remove=badge.locator('[data-user-action="remove"]');
    await remove.waitFor({state:"visible"});
    await host.screenshot({path:path.join(directory,"tap-user-actions.png")});
    const b=await badge.boundingBox(),r=await remove.boundingBox();
    assert.ok(r.y>b.y && r.x+r.width<=b.x+b.width && r.y+r.height<=b.y+b.height, "Delete is inside bottom-right of card");
    let requests=0;
    await host.route("**/api/session-users/remove",async route=>{
      requests++; await new Promise(resolve=>setTimeout(resolve,150));
      if(requests===1)return route.fulfill({status:500,json:{ok:false,error:"Offline failure fixture"}});
      return route.continue();
    });
    await remove.tap();
    assert.equal(await remove.getAttribute("aria-busy"),"true");
    await remove.evaluate(button=>{button.click();button.click();});
    await host.waitForFunction(()=>!document.querySelector('[data-user-action="remove"][aria-busy]'));
    assert.equal(requests,1);
    assert.equal(await remove.isEnabled(),true);
    assert.equal(await host.evaluate(()=>state.data.session_users.length),2);
    await remove.tap();
    await host.waitForFunction(()=>state.data.session_users.length===1);
    assert.equal(requests,2);
    assert.deepEqual(await host.evaluate(()=>state.data.session_users),["New singer"]);
    await host.screenshot({path:path.join(directory,"new-session.png")});
    console.log(JSON.stringify({passed:true,restarts:2,continue:true,new:true,reloadDoesNotPrompt:true,duplicateSafe:true,tapRemoveAndReorder:true,failureAndDoubleTapSafe:true}));
  }finally{await stop();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
