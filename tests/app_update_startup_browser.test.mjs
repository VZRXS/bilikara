// Actual native Host + Chromium + the shell's actual Rust preferences file I/O.
// OS invocation and release responses are bounded local contract fixtures.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {buildNativeHost} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment,waitFor} from './native_host_support.mjs';

async function preferenceBinary() {
  if(process.env.BILIKARA_TEST_UPDATE_PREFERENCE_BINARY)return process.env.BILIKARA_TEST_UPDATE_PREFERENCE_BINARY;
  const built=await runNative('cargo',['build','--manifest-path',path.join(root,'src-tauri/Cargo.toml'),'--example','update_preferences_fixture','--locked','--target','host-tuple','--message-format=json'],process.env,300000);
  assert.equal(built.status,0,built.stderr);
  const files=built.stdout.split('\n').filter(Boolean).map(JSON.parse).filter(item=>item.reason==='compiler-artifact'&&item.target.name==='update_preferences_fixture'&&item.executable);
  assert.equal(files.length,1);return files[0].executable;
}

test('native first launch, reloads and full restarts retain update choices and defer busy checks',{
  skip:process.platform!=='linux'&&'Real Chromium/native Host fixture runs on Linux; native GUI gates remain separate',timeout:300000,
},async()=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-update-startup-'));
  const evidence=process.env.BILIKARA_UPDATE_EVIDENCE||home;
  mkdirSync(evidence,{recursive:true});
  let host,context,page,base,passed=false,busy=false,stateFailures=0,checkFailure=false;
  const checks=[],errors=[],external=[],installs=[],cases=[],preferencesCalls=[];
  const binary=process.env.BILIKARA_TEST_NATIVE_HOST_BINARY||await buildNativeHost();
  const preferences=await preferenceBinary();
  const preferenceHome=path.join(home,'shell');
  async function launch() {
    host=await RunningHost.start(binary,home,['--no-browser','--headless','--port','0','--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')],isolatedEnvironment(home));
    base=host.base;
    context=await chromium.launchPersistentContext(path.join(home,'browser'),{headless:true,viewport:{width:1280,height:900}});
    await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:base})));
    await context.exposeBinding('__updatePreferences',async(_,command,payload)=>{
      preferencesCalls.push(command);
      const action=command==='get_host_update_preferences'?'load':'save';
      const result=await runNative(preferences,[preferenceHome,action,...(action==='save'?[JSON.stringify(payload.preferences)]:[])],isolatedEnvironment(home),10000);
      assert.equal(result.status,0,'Actual native preferences I/O: '+result.stderr);
      return JSON.parse(result.stdout);
    });
    await context.addInitScript(()=>{
      window.__TAURI__={core:{invoke:async(command,payload)=>{
        if(['get_host_update_preferences','set_host_update_preferences'].includes(command))return window.__updatePreferences(command,payload);
        if(command==='get_host_layout')return 'auto';
        if(command==='get_playback_restart_hint_seen')return true;
        return null;
      }}};
    });
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==base){external.push(url.origin);return route.abort();}
      if(url.pathname==='/api/app/update/check'){
        checks.push(route.request().postDataJSON());
        return route.fulfill({status:checkFailure?503:200,contentType:'application/json',body:JSON.stringify(checkFailure?{ok:false,error:'Local release fixture unavailable'}:{ok:true,data:{state:'idle',include_preview:route.request().postDataJSON().include_preview}})});
      }
      if(/\/api\/app\/update\/(install|activate|finish)/u.test(url.pathname)){installs.push(url.pathname);return route.abort();}
      if(url.pathname==='/api/state'&&stateFailures>0){stateFailures--;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'Local state fixture unavailable'})});}
      if(url.pathname==='/api/state'&&busy){const response=await route.fetch();const payload=await response.json();payload.data.app_update={...payload.data.app_update,state:'checking',include_preview:false};return route.fulfill({response,json:payload});}
      return route.continue();
    });
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.waitForFunction(()=>typeof state!=='undefined'&&state.hasValidStateResponse&&!state.updatePreferenceSaveInFlight);
    assert.equal(await page.title(),'bilikara host');assert.equal(new URL(page.url()).origin,base);
    assert.ok((await page.locator('body').innerText()).includes('bilikara'));
  }
  async function stop() {if(context){await context.close();context=null;}if(host){await host.close();host=null;}}
  async function checkCount(expected){await waitFor(()=>checks.length===expected,'Bounded automatic check count',8000);await page.waitForFunction(()=>!state.updateCheckRequestInFlight);}
  async function toggle(id,value){await page.locator(`label[for="${id}"]`).click();await page.waitForFunction(()=>!state.updatePreferenceSaveInFlight&&!state.updateCheckRequestInFlight);assert.equal(await page.locator('#'+id).isChecked(),value);}
  async function stateChoices(){return page.evaluate(()=>({automatic:state.updateAutomaticEnabled,preview:state.updatePreviewEnabled}));}
  try {
    await launch();await checkCount(1);assert.equal(checks[0].include_preview,false);
    assert.deepEqual(await stateChoices(),{automatic:true,preview:false});cases.push('fresh launch: one stable check');
    await page.waitForTimeout(1200);assert.equal(checks.length,1);
    await page.reload();await page.waitForFunction(()=>state.hasValidStateResponse);await checkCount(2);cases.push('each new document: one check, polls: none');
    await page.locator('#work-rail-settings').click();await toggle('update-automatic-checkbox',false);await toggle('update-preview-checkbox',true);
    await page.waitForTimeout(300);await page.screenshot({path:path.join(evidence,'disabled-preview.png'),mask:[page.locator('.remote-mini-control')]});
    for(let restart=0;restart<2;restart++){
      const oldBase=base;await stop();await launch();assert.notEqual(base,oldBase);assert.deepEqual(await stateChoices(),{automatic:false,preview:true});await page.waitForTimeout(1200);assert.equal(checks.length,2);
    }
    cases.push('two complete Host/browser restarts with changed origins: disabled + preview preserved');
    await page.locator('#work-rail-settings').click();await page.waitForTimeout(300);await page.screenshot({path:path.join(evidence,'restart-retains-disabled-preview.png'),mask:[page.locator('.remote-mini-control')]});
    await toggle('update-automatic-checkbox',true);await checkCount(3);assert.equal(checks[2].include_preview,true);
    for(let restart=0;restart<2;restart++){await stop();await launch();await checkCount(4+restart);assert.deepEqual(await stateChoices(),{automatic:true,preview:true});assert.equal(checks.at(-1).include_preview,true);}
    cases.push('two enabled restarts: selected preview channel checked once each');
    busy=true;await stop();await launch();assert.equal(checks.length,5);assert.equal(await page.evaluate(()=>state.startupUpdateCheckScheduled),false);
    await page.waitForTimeout(1200);assert.equal(checks.length,5);busy=false;await checkCount(6);assert.equal(checks.at(-1).include_preview,true);await page.waitForTimeout(1200);assert.equal(checks.length,6);cases.push('busy stable check at startup: preview check deferred then issued once');
    stateFailures=1;await stop();await launch();await checkCount(7);cases.push('first state failure: recovered startup checks once');
    checkFailure=true;await stop();await launch();await checkCount(8);await page.waitForTimeout(1200);assert.equal(checks.length,8);
    checkFailure=false;await page.locator('#work-rail-settings').click();await page.locator('#update-check-button').click();await checkCount(9);cases.push('failed automatic check: no loop; manual retry works');
    assert.equal(preferencesCalls.filter(command=>command==='get_host_update_preferences').length,9,'Load once per new document, never on state polls');
    assert.equal(preferencesCalls.filter(command=>command==='set_host_update_preferences').length,4,'One first-use migration and three explicit setting changes');
    assert.deepEqual(external,[]);assert.deepEqual(installs,[]);assert.deepEqual(errors,[]);
    passed=true;
  } finally {
    await stop();writeFileSync(path.join(evidence,'update-startup-report.json'),JSON.stringify({passed,cases,checks,preferencesCalls,installs,external,pageErrors:errors,coverage:'Actual native Rust Host and preference file I/O; local release/state response and OS invocation contract fixtures; no physical native WebView'},null,2));
    if(passed&&evidence===home)rmSync(home,{recursive:true,force:true});
  }
});
