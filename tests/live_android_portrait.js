"use strict";
// Shared Host + real Rust HTTP/state/media. No online D1/Bilibili calls.
// node tests/live_android_portrait.js EXE PRIVATE_DIR VIDEO AUDIO [CHROME]
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require("playwright");
const [exe, directory, video, audio, executablePath] = process.argv.slice(2);

(async () => {
  const server = spawn(exe, [path.resolve(directory), path.resolve("static"), path.resolve(video), path.resolve(audio)], {stdio:["pipe","pipe","pipe"]});
  const lines = createInterface({input:server.stdout});
  server.stderr.on("data", () => {});
  let browser, page;
  try {
    const bootstrap = JSON.parse(await Promise.race([once(lines,"line").then(v=>v[0]),once(server,"exit").then(()=>{throw Error("Host exited");})])).bootstrap_url;
    browser = await chromium.launch({headless:true, executablePath, args:["--autoplay-policy=no-user-gesture-required"]});
    const context = await browser.newContext({viewport:{width:412,height:850},isMobile:true,hasTouch:true});
    // Physical orientation is independent of a keyboard-resized WebView.
    await context.addInitScript(() => {
      Object.defineProperty(screen.orientation,"type",{configurable:true,get:()=>window.testOrientation || "portrait-primary"});
    });
    await context.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    page = await context.newPage();
    const errors=[];
    page.on("pageerror", e=>errors.push(e.message));
    await page.goto(bootstrap);
    await page.waitForFunction(()=>window.BilikaraAndroidHost?.isPortrait() && state.data?.current_item?.cache_status === "ready");
    await page.waitForFunction(()=>document.querySelector("video").currentTime>0.3);
    const originalVideo=await page.locator("video").elementHandle();
    const originalAudio=await page.locator("audio").first().elementHandle();
    const dock=page.locator("#android-host-dock");
    const clickPage = async name => {
      await dock.locator(`[data-android-page="${name}"]`).click();
      assert.equal(await dock.locator(`[data-android-page="${name}"]`).getAttribute("aria-current"), "page");
      assert.equal(await page.locator(".topbar").isVisible(), name === "playback");
      const rows = await page.locator(".app-shell").evaluate(el => getComputedStyle(el).gridTemplateRows);
      assert.equal(rows.split(" ")[0], name === "playback" ? "56px" : "0px");
      await page.waitForFunction(()=>!document.querySelector("video").paused);
    };
    const assertFit = async () => {
      const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
        dock:document.querySelector("#android-host-dock").getBoundingClientRect().toJSON(),height:innerHeight}));
      assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify(bounds));
      assert.ok(bounds.dock.bottom<=bounds.height+1,JSON.stringify(bounds));
      for(const button of await dock.locator("button").all()) {
        const box=await button.boundingBox();
        assert.ok(box.width>=44 && box.height>=44,JSON.stringify(box));
        await button.click({trial:true});
      }
    };
    await assertFit();
    await page.screenshot({path:path.join(directory,"portrait-playback.png")});
    await clickPage("queue");
    assert.equal(await page.locator("#host-workspace-queue").isVisible(),true);
    await page.locator('[data-android-workspace="history"]').click();
    assert.equal(await page.locator("#host-workspace-history").isVisible(),true);
    await clickPage("request");
    await page.locator('[data-request-view="discover"]').click();
    assert.equal(await page.locator("#request-discover-panel").isVisible(),true);
    await page.screenshot({path:path.join(directory,"portrait-request.png")});
    await page.locator('[data-android-workspace="random"]').click();
    assert.equal(await page.locator("#gatcha-panel").isVisible(),true);
    assert.equal(await page.locator("#android-request-random").getAttribute("aria-selected"),"true");
    await page.locator('[data-request-view="discover"]').click();
    assert.equal(await page.locator("#request-discover-panel").isVisible(),true);
    assert.equal(await page.locator("#android-request-random").getAttribute("aria-selected"),"false");
    await page.locator('[data-request-view="sources"]').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#gatcha-panel").isVisible(),true);
    await clickPage("users");
    assert.equal(await page.locator("#session-users-panel").isVisible(),true);
    await clickPage("my");
    await page.locator("#android-open-settings").click();
    await page.locator("#cache-quality-select").selectOption("1080P 高清");
    await page.waitForFunction(()=>state.data.cache_policy.video_quality==="1080P 高清");
    await page.screenshot({path:path.join(directory,"portrait-settings.png")});
    assert.equal(await page.locator("#cache-settings").evaluate(el=>el.parentElement.id),"android-settings-slot");
    await page.goBack();
    assert.equal(await page.locator("#android-my-page").isVisible(),true);
    await clickPage("playback");
    // A programmatic redirect (not a dock click) must still expose Users.
    await page.evaluate(()=>activateHostWorkspace("users"));
    assert.equal(await page.locator("html").getAttribute("data-android-page"),"users");
    await clickPage("request");
    await page.locator('[data-request-view="quick"]').click();
    await page.locator("#url-input").fill("portrait keyboard draft");
    await page.setViewportSize({width:412,height:310});
    await assertFit();
    assert.equal(await page.locator("html").getAttribute("data-android-layout"),"portrait");
    assert.equal(await page.locator("#url-input").inputValue(),"portrait keyboard draft");
    // Rotate without destroying the playing media elements or the draft.
    await page.evaluate(()=>{window.testOrientation="landscape-primary";screen.orientation.dispatchEvent(new Event("change"));});
    await page.setViewportSize({width:850,height:412});
    assert.equal(await dock.isVisible(),false);
    assert.equal(await page.locator("#work-rail").isVisible(),true);
    assert.equal(await page.locator("#android-request-random").isVisible(),false);
    assert.equal(await page.locator(".request-subview-tabs").evaluate(el=>!!el.closest(".request-workspace-head")),true);
    assert.equal(await page.locator("#cache-settings").evaluate(el=>el.closest(".topbar")!==null),true);
    await page.evaluate(()=>{window.testOrientation="portrait-primary";screen.orientation.dispatchEvent(new Event("change"));});
    await page.setViewportSize({width:360,height:780});
    await assertFit();
    await clickPage("playback");
    assert.equal(await originalVideo.evaluate(el=>el===document.querySelector("video") && el.isConnected && !el.paused),true);
    assert.equal(await originalAudio.evaluate(el=>el===document.querySelector("audio") && el.isConnected && !el.paused),true);
    const before=await originalVideo.evaluate(el=>el.currentTime);
    await page.waitForFunction(t=>document.querySelector("video").currentTime>t+0.3,before);
    await page.screenshot({path:path.join(directory,"portrait-360.png")});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,pages:5,queueHistory:true,random:true,settingsPersisted:true,back:true,orientation:true,keyboard:true,persistentMedia:true,onlineRequests:0}));
  } catch(e) {
    if(page) {
      console.log(await page.evaluate(()=>Array.from(document.querySelectorAll(".app-shell > *, .host-content-region > *")).map(el=>({id:el.id || el.className,hidden:el.hidden,display:getComputedStyle(el).display,gridRow:getComputedStyle(el).gridRow,rect:el.getBoundingClientRect().toJSON()}))).catch(()=>[]));
      await page.screenshot({path:path.join(directory,"failed.png")}).catch(()=>{});
    }
    throw e;
  } finally {
    if(browser) await browser.close();
    server.stdin.end("stop\n");lines.close();
    if(server.exitCode===null) await once(server,"exit");
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
