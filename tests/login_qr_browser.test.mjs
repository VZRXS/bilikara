import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {rmSync} from 'node:fs';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {root} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {buildNativeAlpha, buildNativeHost} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment, waitFor} from './native_host_support.mjs';

let alpha, desktop;
before(async()=>{
  if(process.platform!=='linux') return;
  alpha=process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();
  desktop=process.env.BILIKARA_TEST_NATIVE_HOST_BINARY || await buildNativeHost();
},{timeout:300000});
const qr=key=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="168" height="168"><rect width="168" height="168" fill="white"/><text x="20" y="84">Fixture ${key}</text></svg>`).toString('base64');
const login=key=>({state:'waiting',logged_in:false,message:'请使用哔哩哔哩 App 扫码登录',qr_image:qr(key),login_url:`https://account.bilibili.com/fixture-login?key=${key}`});

for(const engine of [chromium,webkit])for(const platform of ['desktop','android'])test(`${engine.name()} ${platform} QR and badge refresh keep the browser link in the same login generation`,{timeout:120000,skip:process.platform!=='linux'},async t=>{
  const home=ownedDirectory('login QR generation');t.after(()=>rmSync(home,{recursive:true,force:true}));
  const android=platform==='android';
  const host=await RunningHost.start(android?alpha:desktop,home,android?[home,path.join(root,'static')]:['--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')],isolatedEnvironment(home),android);
  t.after(()=>host.close());
  const browser=await engine.launch();t.after(()=>browser.close());
  const context=await browser.newContext({viewport:android?{width:393,height:736}:{width:1280,height:900},hasTouch:android});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(android=>{
    localStorage.setItem('bilikara.update.automatic','false');
    if(android)window.BilikaraHostWindow={postMessage(raw){if(['enter','exit'].includes(raw))return;const {id}=JSON.parse(raw);queueMicrotask(()=>this.onmessage({data:JSON.stringify({id,ok:true,data:{layout:'auto',orientation:'system'}})}))}};
  },android);
  await context.route('**/*',r=>new URL(r.request().url()).origin===host.base?r.continue():r.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(host.base);await page.waitForFunction(()=>typeof state!=='undefined'&&state.hasValidStateResponse);
  await page.evaluate(()=>{state.eventSource?.close();fetchState=async()=>{};setLanguage('zh');});
  // Install the isolated waiting state before opening desktop Settings, so no
  // provider request can be triggered by that surface's automatic startup.
  await page.evaluate(value=>{state.data.bbdown.login=value;renderBBDownLogin(value);},login('initial'));
  await page.locator(android?'[data-android-page="my"]':'#cache-settings-toggle').click();
  const image=page.locator('#bbdown-login-qr-image'),action=page.locator('#bbdown-login-refresh'),link=page.locator('#bbdown-login-link');
  await image.waitFor({state:'visible'});
  const quiet=await action.evaluate(n=>{
    const reference=document.querySelector('.remote-access-qr'),a=getComputedStyle(n),b=getComputedStyle(reference);
    return {login:[a.paddingTop,a.paddingRight,a.paddingBottom,a.paddingLeft],access:[b.paddingTop,b.paddingRight,b.paddingBottom,b.paddingLeft]};
  });assert.deepEqual(quiet.login,['3px','3px','3px','3px']);assert.deepEqual(quiet.login,quiet.access,'login and phone-access share one white-frame token');

  assert.equal(await page.locator('.bbdown-login-refresh').count(),0,'no separate text refresh button');
  assert.equal(await page.locator('#bbdown-login-message').textContent(),await page.evaluate(()=>t('service.scanWithBilibiliApp')));
  assert.equal(await page.locator('#bbdown-login-message').evaluate(n=>getComputedStyle(n).fontSize),'13px');
  let calls=0,nextFailure=false,release;
  await page.route('**/api/bbdown/login/start',async route=>{
    const key=String(++calls);assert.equal(route.request().postDataJSON().force,true);
    await new Promise(resolve=>{release=resolve;});
    if(nextFailure){nextFailure=false;return route.fulfill({status:503,json:{ok:false,error:'isolated login unavailable'}});}
    const snapshot=await page.evaluate(value=>({...state.data,state_revision:state.data.state_revision+1,bbdown:{...state.data.bbdown,login:value}}),login(key));
    return route.fulfill({json:{ok:true,data:snapshot}});
  });
  t.after(()=>release?.());
  async function pending(){
    await page.waitForFunction(()=>state.bbdownLoginRequesting);
    assert.equal(await action.isDisabled(),true);assert.equal(await action.getAttribute('aria-busy'),'true');
    assert.equal(await link.getAttribute('href'),null,'old link removed immediately, before response');
    assert.equal(await link.isVisible(),false);
    await page.evaluate(()=>{document.getElementById('bbdown-login-refresh').click();document.getElementById('bbdown-login-button').click();});
  }
  async function complete(key){
    await page.waitForFunction(()=>!state.bbdownLoginRequesting);
    assert.equal(await image.getAttribute('src'),qr(key));assert.equal(await link.getAttribute('href'),android?login(key).login_url:'https://account.bilibili.com/login');
    assert.equal(await action.isDisabled(),false);assert.equal(await action.getAttribute('aria-busy'),null);
  }
  await action.click();await pending();assert.equal(calls,1);release();await complete('1');
  await page.locator('#bbdown-login-button').click();await pending();assert.equal(calls,2);release();await complete('2');
  await page.evaluate(()=>{state.data.bbdown.login={state:'failed',logged_in:false,message:'二维码已过期，请重新生成'};renderBBDownLogin(state.data.bbdown.login);});
  await pending();assert.equal(calls,3);release();await complete('3');
  // Failure must restore the current still-valid QR/link and must not retry
  // forever while desktop Settings remains open.
  nextFailure=true;await action.click();await pending();assert.equal(calls,4);release();await complete('3');
  await page.evaluate(()=>renderBBDownLogin(state.data.bbdown.login));assert.equal(calls,4);
  await action.focus();await page.keyboard.press('Enter');await pending();assert.equal(calls,5);release();await complete('5');
  const opened=[];let finishLogin;
  await page.exposeFunction('fixtureOpenLogin',async url=>{
    opened.push(url);
    if(!android)await new Promise(resolve=>{finishLogin=resolve;});
  });
  await page.evaluate(platform=>{
    if(platform==='android')window.BilikaraAndroidPlatform={openLoginLink:url=>fixtureOpenLogin(url)};
    else window.__TAURI__={core:{invoke:(command,args)=>{if(command==='open_bilibili_login')return fixtureOpenLogin('native-login-window');if(command==='open_external_web_url')throw new Error('desktop login must not open the QR payload in a browser');return Promise.resolve({});}}};
  },platform);
  await link.click();
  if(!android){
    await page.waitForFunction(()=>state.bbdownWebLoginRequesting);
    await page.evaluate(()=>{
      document.getElementById('bbdown-login-link').click();
      document.getElementById('bbdown-login-refresh').click();
      document.getElementById('bbdown-login-button').click();
    });
    assert.equal(calls,5);assert.equal(await action.isDisabled(),true);
    await waitFor(()=>Boolean(finishLogin),'native login command must be pending');
    finishLogin();
  }
  await page.waitForFunction(()=>!document.getElementById('bbdown-login-link').hasAttribute('aria-busy'));
  assert.deepEqual(opened,[android?login('5').login_url:'native-login-window']);assert.equal(new URL(page.url()).origin,host.base);
  if(!android){
    await page.evaluate(()=>{
      window.__TAURI__.core.invoke=()=>Promise.reject('isolated login unavailable');
      fetchState=async()=>{throw new Error('isolated reconnect unavailable');};
    });
    await link.click();
    await page.waitForFunction(()=>!state.bbdownWebLoginRequesting&&!document.getElementById('bbdown-login-link').hasAttribute('aria-busy'));
    assert.equal(await action.isDisabled(),false);
    assert.equal(await action.getAttribute('aria-busy'),null);
  }
  for(const value of [{state:'starting'},{state:'failed'},{state:'logged_in',logged_in:true}]){
    await page.evaluate(value=>{state.data.bbdown.login={...value,login_url:'https://account.bilibili.com/old'};renderBBDownLogin(state.data.bbdown.login,{startIfNeeded:false});},value);
    if(android||value.logged_in){assert.equal(await link.getAttribute('href'),null);assert.equal(await link.isVisible(),false);}else{assert.equal(await link.getAttribute('href'),'https://account.bilibili.com/login');assert.equal(await link.isVisible(),true);}
  }
  assert.deepEqual(errors,[]);
});
