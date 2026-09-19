"use strict";
// Offline shared Host acceptance. Native preference RPC is stubbed here; actual
// Activity rotation/fullscreen/persistence must also be checked on Android.
// node tests/live_android_layout.cjs EXE PRIVATE_DIR VIDEO AUDIO CHROME
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {once}=require("node:events");
const {createInterface}=require("node:readline");
const fs=require("node:fs/promises");
const path=require("node:path");
const {chromium}=require("playwright");
const [exe,directory,video,audio,executablePath]=process.argv.slice(2);
(async()=>{
  const server=spawn(exe,[path.resolve(directory),path.resolve("static"),path.resolve(video),path.resolve(audio)],{stdio:["pipe","pipe","pipe"]});
  const lines=createInterface({input:server.stdout});server.stderr.on("data",()=>{});
  let browser,page;
  try {
    const bootstrap=JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error("Host exited");})])).bootstrap_url;
    browser=await chromium.launch({headless:true,executablePath,args:["--autoplay-policy=no-user-gesture-required"]});
    const context=await browser.newContext({viewport:{width:412,height:850},isMobile:true,hasTouch:true,locale:"zh-CN"});
    await context.addInitScript(()=>{
      let saved={layout:"auto",orientation:"system"};
      window.BilikaraHostWindow={postMessage(raw){
        if(["enter","exit"].includes(raw)) return;
        const {id,action,mode}=JSON.parse(raw);
        if(action==="set-layout") saved={...saved,layout:mode};
        if(action==="set-orientation") saved={...saved,orientation:mode};
        queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:saved})}));
      }};
    });
    await context.route("**/*",route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith("/api/d1/") || /\/api\/(catalog|gatcha)\/(search|status)/.test(url.pathname)) return route.fulfill({json:{ok:true,data:{items:[],tags:[],has_more:false}}});
      return url.hostname==="127.0.0.1" ? route.continue() : route.abort();
    });
    page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(bootstrap);
    await page.waitForFunction(()=>document.querySelector("video")?.currentTime>0.3);
    await page.evaluate(()=>{window.layoutTestMedia={video:document.querySelector("video"),audio:document.querySelector("audio"),draft:document.querySelector("#url-input")};});
    const assertMedia=async()=>{
      const result=await page.evaluate(()=>({sameVideo:layoutTestMedia.video===document.querySelector("video"),sameAudio:layoutTestMedia.audio===document.querySelector("audio"),sameInput:layoutTestMedia.draft===document.querySelector("#url-input"),videoPaused:layoutTestMedia.video.paused,audioPaused:layoutTestMedia.audio.paused}));
      assert.deepEqual(result,{sameVideo:true,sameAudio:true,sameInput:true,videoPaused:false,audioPaused:false});
      const before=await page.evaluate(()=>layoutTestMedia.video.currentTime);
      await page.waitForFunction(t=>layoutTestMedia.video.currentTime>t+0.2,before);
    };
    const dock=page.locator("#android-host-dock");
    await dock.locator('[data-android-page="request"]').click();
    await page.locator('[data-request-view="quick"]').click();
    await page.locator("#url-input").fill("saved layout search draft");
    const metrics=[];
    for(const [width,height,layout] of [[412,250,"portrait"],[844,390,"landscape"],[1024,768,"landscape"],[1280,800,"landscape"],[800,1280,"landscape"],[600,960,"portrait"],[412,850,"portrait"]]) {
      await page.setViewportSize({width,height});
      await page.waitForFunction(mode=>document.documentElement.dataset.androidLayout===mode,layout);
      assert.equal(await dock.isVisible(),layout==="portrait");
      assert.equal(await page.locator("#work-rail").isVisible(),layout!=="portrait");
      assert.equal(await page.locator("#url-input").inputValue(),"saved layout search draft");
      await assertMedia();
      if(layout!=="portrait") {
        // The shared desktop rail toggles an already-selected narrow drawer.
        // Open it only when closed; a second click intentionally hides it.
        if(!await page.locator('[data-request-view="quick"]').isVisible()) await page.locator("#work-rail-request").click();
        await page.locator('[data-request-view="quick"]').click();
        await page.locator("#url-input").click({trial:true});
        assert.equal(await page.locator("#presentation-settings").evaluate(el=>!!el.closest(".topbar")),true);
      }
      const bounds=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,toolLayout:document.querySelector(".app-shell").dataset.narrowToolLayout}));
      assert.ok(bounds.scrollWidth<=width+1,JSON.stringify(bounds));metrics.push(bounds);
      await page.screenshot({path:path.join(directory,`auto-${width}-${height}.png`)});
    }
    await dock.locator('[data-android-page="my"]').click();await page.locator("#android-open-settings").click();
    const choose=async mode=>{
      const button=page.locator(`button[data-android-layout-mode="${mode}"]`);
      await button.click();await page.waitForFunction(mode=>document.documentElement.dataset.androidLayoutMode===mode,mode);
      assert.equal(await button.getAttribute("aria-pressed"),"true");await assertMedia();
    };
    await choose("desktop");assert.equal(await dock.isVisible(),false);
    await page.setViewportSize({width:1280,height:800});
    await page.locator("#work-rail-settings").click();
    for(const locale of ["en","ja","zh"]) {
      await page.locator(`[data-language="${locale}"]`).click();
      await page.locator("#android-layout-switch").scrollIntoViewIfNeeded();
      for(const button of await page.locator(".android-window-preferences button").all()) await button.click({trial:true});
      await page.screenshot({path:path.join(directory,`desktop-settings-${locale}.png`)});
    }
    await choose("phone");assert.equal(await dock.isVisible(),true);
    await page.screenshot({path:path.join(directory,"manual-phone-tablet.png")});
    await page.locator('[data-android-orientation-mode="portrait"]').click();
    assert.equal(await dock.isVisible(),true,"Direction is separate from layout");
    await choose("auto");assert.equal(await dock.isVisible(),false);
    await page.locator("#work-rail-users").click();
    await page.setViewportSize({width:412,height:850});
    await page.waitForFunction(()=>document.documentElement.dataset.androidPage==="users");
    await assertMedia();
    assert.deepEqual(errors,[]);
    const result={passed:true,metrics,manualModes:true,translations:3,persistentMedia:true,persistentDraft:true,workspaceRestored:true};
    await fs.writeFile(path.join(directory,"result.json"),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } catch(error) {
    if(page) await page.screenshot({path:path.join(directory,"failed.png")}).catch(()=>{});
    throw error;
  } finally {
    if(browser) await browser.close();server.stdin.end("stop\n");lines.close();
    if(server.exitCode===null) await once(server,"exit");
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
