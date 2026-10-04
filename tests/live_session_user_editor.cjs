"use strict";
// Real native HTTP/SSE, shared-device rename, and the Host editing controls.
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const path = require("node:path");
const {chromium} = require("playwright");
const [exe, directory, executablePath] = process.argv.slice(2);

(async () => {
  await fs.mkdir(directory, {recursive:true});
  const server = spawn(exe, [path.join(directory,"data"), path.resolve("static")], {stdio:["pipe","pipe","pipe"]});
  let diagnostics="";server.stderr.on("data", data => { diagnostics += data; });
  const lines=createInterface({input:server.stdout});
  const bootstrap=JSON.parse((await Promise.race([
    once(lines,"line"),
    once(server,"exit").then(()=>{throw new Error(`Host exited during startup: ${diagnostics.slice(-1500)}`);}),
    new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error("Host startup timed out")),20000);timer.unref();}),
  ]))[0]).bootstrap_url;
  const browser=await chromium.launch({headless:true,...(executablePath ? {executablePath} : {})});
  const errors=[];
  const hostContext=await browser.newContext({viewport:{width:1280,height:800}});
  const remoteContexts=[];
  const host=await hostContext.newPage();
  host.on("pageerror", error => errors.push(error.message));
  const checks=[];
  async function remote() {
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    remoteContexts.push(context);
    const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
    await page.goto(new URL("/remote",bootstrap).href);
    await page.waitForFunction(()=>state.data?.session_user_entries?.length);
    await page.evaluate(async()=>applyRemoteIdentity(await apiPost("/api/remote-identity/register",{name:"Alice",claim:true})));
    return page;
  }
  try {
    await host.goto(bootstrap);
    await host.waitForFunction(()=>state.data?.session_user_edit_version===1);
    assert.match(await host.title(),/bilikara/i);
    await host.evaluate(()=>setLanguage("zh"));
    await host.locator("#work-rail-users").click();
    assert.equal(await host.locator('.session-user-empty').count(),1);
    for (const name of ["Alice","Bob","Carol"]) {
      await host.locator("#session-user-input").fill(name);
      await host.locator("#session-user-form button").click();
      await host.waitForFunction(name=>state.data.session_users.includes(name),name);
    }
    assert.equal(await host.locator(".session-user-badge").count(),3);
    assert.equal(await host.locator('.session-user-empty, [data-i18n="session.help"]').count(),0);
    const originalHeight=await host.locator(".session-user-badge").first().evaluate(node=>node.getBoundingClientRect().height);
    const aliceId=await host.evaluate(()=>state.data.session_user_entries.find(user=>user.name==="Alice").id);
    await host.evaluate(()=>{globalThis.originalAliceNode=document.querySelector('.session-user-badge[data-name="Alice"]');elements.requesterSelect.value="Alice";});
    const first=await remote();const second=await remote();
    await host.locator('[data-mode="select"]').click();
    await host.locator('#session-user-list .session-user-badge[data-name="Alice"] .session-user-checkbox').check();
    await host.locator('#session-user-list .session-user-badge[data-name="Bob"] .session-user-checkbox').check();
    assert.equal(await host.locator(".session-user-checkbox:checked").count(),2);
    assert.equal(await host.locator(".session-user-badge").first().evaluate(node=>node.getBoundingClientRect().height),originalHeight);
    // A phone joins while Host is selecting: preserve selection, leave newcomer unselected.
    await host.evaluate(()=>apiPost("/api/session-users/add",{name:"New phone"}));
    await host.locator('#session-user-list .session-user-badge[data-name="New phone"]').waitFor();
    assert.equal(await host.locator(".session-user-checkbox:checked").count(),2);
    assert.equal(await host.locator('#session-user-list .session-user-badge[data-name="New phone"] .session-user-checkbox').isChecked(),false);
    await host.locator("#session-users-panel").screenshot({path:path.join(directory,"users-select.png")});
    checks.push("selection survives live addition; unchanged tag height");
    // Use a real native drag/drop, and commit only on drop (never dragend).
    await host.bringToFront();
    await host.evaluate(()=>{globalThis.dragEvents=[];for(const type of ['dragstart','dragover','drop','dragend'])document.querySelector('.session-user-list').addEventListener(type,event=>dragEvents.push({type,target:event.target.className,x:event.clientX,y:event.clientY}));});
    await host.locator('#session-user-list .session-user-badge[data-name="Alice"]').dragTo(host.locator('#session-user-list .session-user-badge[data-name="New phone"]'),{targetPosition:{x:8,y:18}});
    try { await host.waitForFunction(()=>state.data.session_users.join(",")==="Carol,Alice,Bob,New phone",null,{timeout:5000}); }
    catch(error) { throw new Error(error.message + "\n" + JSON.stringify(await host.evaluate(()=>({users:state.data.session_users,mode:state.sessionUserEditor.mode,drag:state.sessionUserEditor.drag,events:dragEvents,message:document.querySelector('#app-message')?.textContent})))); }
    checks.push("selected users move as one ordered block");
    await host.locator('[data-mode="rename"]').click();
    assert.equal(await host.locator(".session-user-checkbox:visible").count(),0);
    await host.locator('#session-user-list .session-user-badge[data-name="Alice"] .session-user-name').click();
    await host.locator("#session-user-rename-input").fill("Aimer");
    await host.locator('.session-user-rename-panel').evaluate(panel=>
      Promise.allSettled(panel.getAnimations().map(animation=>animation.finished)));
    const actions=await host.locator('.session-user-rename-actions button').evaluateAll(buttons=>buttons.map(button=>{
      const style=getComputedStyle(button);
      return {height:button.getBoundingClientRect().height,font:style.fontSize,radius:style.borderRadius,background:style.backgroundColor};
    }));
    assert(actions.every(button=>button.height===44 && button.font==='16px' && button.radius==='14px'));
    assert.notEqual(actions[0].background,actions[1].background);
    await host.locator('#app-toast').waitFor({state:'hidden'});
    await host.screenshot({path:path.join(directory,"users-rename.png"),fullPage:false});
    await host.locator('.session-user-rename-panel [type="submit"]').click();
    await host.waitForFunction(()=>state.data.session_users.includes("Aimer"));
    await first.waitForFunction(()=>state.remoteIdentity.name==="Aimer");
    await second.waitForFunction(()=>state.remoteIdentity.name==="Aimer");
    assert.equal(await host.evaluate(()=>originalAliceNode===document.querySelector('.session-user-badge[data-name="Aimer"]')),true);
    assert.equal(await host.locator("#requester-select").inputValue(),"Aimer");
    assert.equal(await first.evaluate(()=>state.remoteIdentity.userId),aliceId);
    checks.push("Host rename updates both devices and requester selection; node and ID preserved");
    // Remote's ordinary rename form reaches the same command semantics.
    await first.evaluate(()=>openRemoteIdentityRename());
    await first.locator("#remote-identity-input").fill("Chorus");
    await first.locator("#remote-identity-form").evaluate(form=>form.requestSubmit());
    await host.waitForFunction(()=>state.data.session_users.includes("Chorus"));
    await second.waitForFunction(()=>state.remoteIdentity.name==="Chorus");
    checks.push("local Remote rename syncs Host and other device");
    await host.locator('#session-user-list .session-user-badge[data-name="Chorus"] .session-user-name').click();
    await host.locator('#session-user-rename-input').fill('Unsent draft');
    await second.evaluate(async()=>applyRemoteIdentity(await apiPost('/api/remote-identity/rename',
      {name:'Synced',user_id:state.remoteIdentity.userId,expected_name:state.remoteIdentity.name})));
    await host.locator('.session-user-rename-panel').waitFor({state:'hidden'});
    await host.waitForFunction(()=>state.data.session_users.includes('Synced'));
    checks.push("external rename dismisses a stale editor without submitting its draft");
    // Canceling a drag must not reorder. An SSE edit cancels an in-flight drag.
    const before=await host.evaluate(()=>state.data.session_users);
    await host.locator('[data-mode="select"]').click();
    await host.locator('#session-user-list .session-user-badge[data-name="Bob"]').dispatchEvent("dragstart",{dataTransfer:await host.evaluateHandle(()=>new DataTransfer())});
    await host.locator('#session-user-list .session-user-badge[data-name="Carol"]').dispatchEvent("dragover",{dataTransfer:await host.evaluateHandle(()=>new DataTransfer()),clientX:0,clientY:0});
    await host.locator('#session-user-list .session-user-badge[data-name="Bob"]').dispatchEvent("dragend");
    assert.deepEqual(await host.evaluate(()=>state.data.session_users),before);
    checks.push("canceled drag does not commit");
    const orderIds=await host.evaluate(()=>state.data.session_user_entries.map(user=>user.id));
    await host.locator('#session-user-list .session-user-badge[data-name="Bob"]').dispatchEvent('dragstart',{dataTransfer:await host.evaluateHandle(()=>new DataTransfer())});
    await first.evaluate(async()=>applyRemoteIdentity(await apiPost('/api/remote-identity/rename',
      {name:'Singer',user_id:state.remoteIdentity.userId,expected_name:state.remoteIdentity.name})));
    await host.waitForFunction(()=>state.data.session_users.includes('Singer') && !state.sessionUserEditor.drag);
    await host.locator('#session-user-list .session-user-badge[data-name="Carol"]').dispatchEvent('drop');
    assert.deepEqual(await host.evaluate(()=>state.data.session_user_entries.map(user=>user.id)),orderIds);
    checks.push("live roster change cancels a stale drag without overwriting order");
    await host.locator(".session-user-select-all").click();
    assert.equal(await host.locator(".session-user-checkbox:checked").count(),4);
    await host.locator("#session-user-trash").click();
    await host.waitForFunction(()=>state.data.session_users.length===0);
    await first.waitForFunction(()=>!state.remoteIdentity.registered);
    await second.waitForFunction(()=>!state.remoteIdentity.registered);
    checks.push("atomic batch deletion revokes both devices");
    for (let index=1;index<=32;index++) await host.evaluate(async index=>{await apiPostStateSnapshot("/api/session-users/add",{name:`用户 ${index}`});render();},index);
    for (const width of [700,1024,1440]) {
      await host.setViewportSize({width,height:720});
      await host.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      if (!(await host.locator('[data-mode="select"]').isVisible())) await host.locator("#work-rail-users").click();
      await host.locator('[data-mode="select"]').waitFor({state:"visible"});
      await host.screenshot({path:path.join(directory,`users-${width}.png`)});
      if (await host.locator('[data-mode="select"]').getAttribute("aria-pressed") !== "true") await host.locator('[data-mode="select"]').click();
      const geometry=await host.evaluate(()=>{
        const stage=document.querySelector(".session-user-stage").getBoundingClientRect();
        const list=document.querySelector(".session-user-list").getBoundingClientRect();
        const trash=document.querySelector("#session-user-trash").getBoundingClientRect();
        const rename=document.querySelector('[data-mode="rename"]').getBoundingClientRect();
        const scroll=document.querySelector(".session-user-list");
        return {listBottom:list.bottom,trashTop:trash.top,trashBottom:trash.bottom,stageBottom:stage.bottom,trashRight:trash.right,stageRight:stage.right,renameRight:rename.right,trashLeft:trash.left,overflow:document.documentElement.scrollWidth>innerWidth+1,scrolls:scroll.scrollHeight>scroll.clientHeight};
      });
      assert.equal(geometry.overflow,false,JSON.stringify({width,geometry}));
      assert(geometry.listBottom<=geometry.trashTop,JSON.stringify({width,geometry}));
      assert(geometry.trashRight<=geometry.stageRight,JSON.stringify({width,geometry}));
      assert(geometry.renameRight<geometry.trashLeft,JSON.stringify({width,geometry}));
      assert(geometry.stageBottom-geometry.trashBottom<=5,JSON.stringify({width,geometry}));
      if (width===700) {
        const blur=await host.evaluate(()=>({outer:getComputedStyle(document.querySelector('.host-workspace-region')).backdropFilter,
          inner:getComputedStyle(document.querySelector('#session-users-panel')).backdropFilter}));
        assert.match(blur.outer,/blur\(/);assert.equal(blur.inner,'none');
        await host.evaluate(()=>{const sheet=document.querySelector('.host-workspace-region');sheet.style.backdropFilter='none';sheet.style.webkitBackdropFilter='none';});
        await host.screenshot({path:path.join(directory,'users-700-blur-off.png')});
        await host.evaluate(()=>{const sheet=document.querySelector('.host-workspace-region');sheet.style.removeProperty('backdrop-filter');sheet.style.removeProperty('-webkit-backdrop-filter');});
        await host.screenshot({path:path.join(directory,'users-700-blurred.png')});
      }
      for (const language of ["zh","en","ja"]) {
        await host.evaluate(language=>setLanguage(language),language);
        assert.equal(await host.locator('[data-mode="rename"]').getAttribute("aria-label")!=="session.renameMode",true);
      }
      await host.locator('[data-mode="select"]').click();
    }
    checks.push("700/1024/1440 layouts; zh/en/ja controls; reserved trash clearance");
    await host.setViewportSize({width:700,height:720});
    await host.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    if (!(await host.locator('[data-mode="select"]').isVisible())) await host.locator('#work-rail-users').click();
    await host.evaluate(()=>setLanguage('zh'));
    await host.locator('[data-mode="select"]').click();
    await host.locator('#session-user-list .session-user-checkbox').nth(0).check();
    await host.locator('#session-user-list .session-user-checkbox').nth(1).check();
    await host.locator('#app-toast').waitFor({state:'hidden'});
    await host.locator('#session-users-panel').screenshot({path:path.join(directory,'users-compact.png')});

    const touchContext=await browser.newContext({storageState:await hostContext.storageState(),viewport:{width:1280,height:800},hasTouch:true});
    const touch=await touchContext.newPage();
    touch.on('pageerror',error=>errors.push(error.message));
    await touch.goto(new URL('/',bootstrap).href);
    await touch.waitForFunction(()=>state.data?.session_user_edit_version===1);
    await touch.locator('#work-rail-users').tap();
    await touch.locator('[data-mode="select"]').tap();
    await touch.locator('#session-user-list .session-user-checkbox').nth(0).tap();
    await touch.locator('#session-user-list .session-user-checkbox').nth(1).tap();
    assert.equal(await touch.locator('#session-user-list .session-user-checkbox:checked').count(),2);
    const touchIds=await touch.evaluate(()=>state.data.session_user_entries.map(user=>user.id));
    const start=await touch.locator('#session-user-list .session-user-order-number').nth(0).boundingBox();
    const target=await touch.locator('#session-user-list .session-user-badge').nth(8).boundingBox();
    const cdp=await touchContext.newCDPSession(touch);
    const point=(box)=>({x:box.x+8,y:box.y+box.height/2});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(start)]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x+8,y:start.y+start.height/2+8}]});
    await touch.waitForFunction(()=>!!state.sessionUserEditor.drag);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(target)]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await touch.waitForFunction(first=>state.data.session_user_entries[0].id!==first,touchIds[0]);
    const reordered=await touch.evaluate(()=>state.data.session_user_entries.map(user=>user.id));
    assert.equal(reordered.indexOf(touchIds[1]),reordered.indexOf(touchIds[0])+1);
    assert.equal(await touch.locator('#session-user-list .session-user-checkbox:checked').count(),2);
    const cancelStart=await touch.locator('#session-user-list .session-user-order-number').nth(0).boundingBox();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(cancelStart)]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cancelStart.x+8,y:cancelStart.y+cancelStart.height/2+8}]});
    await touch.waitForFunction(()=>!!state.sessionUserEditor.drag);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    assert.equal(await touch.evaluate(()=>!!state.sessionUserEditor.drag),false);
    assert.deepEqual(await touch.evaluate(()=>state.data.session_user_entries.map(user=>user.id)),reordered);
    await touchContext.close();
    checks.push('touch checkbox selection, immediate group drag, and interrupted gesture cancellation');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:checks,screenshots:["users-select.png","users-rename.png"]}));
  } finally {
    await browser.close();server.stdin.end("stop\n");lines.close();
    if(server.exitCode===null)await once(server,"exit");
    assert.equal(server.exitCode,0,diagnostics.slice(-1500));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
