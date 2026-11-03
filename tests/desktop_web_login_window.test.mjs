// Actual Tauri/WebKit window; all web traffic terminates in an owned HTTP proxy.
// HTTP is deliberate for this fixture. Production uses a fixed HTTPS URL only.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {root, executableOnPath, runNative} from './desktop_construction_support.mjs';
import {CapturedProcess} from './macos_smoke_process.mjs';
import {isolatedEnvironment, waitFor} from './native_host_support.mjs';
import {localServer} from './video_service_fixture.mjs';

test('actual native login WebView denies IPC/downloads, reads HttpOnly cookies and loses its ephemeral session on close', {timeout:240000,skip:process.platform!=='linux'}, async t => {
  const tools = Object.fromEntries(['Xvfb','openbox','scrot','xdotool'].map(name=>[name,executableOnPath(name)]));
  assert.ok(Object.values(tools).every(Boolean),'native window verification requires X11 tools');
  const build = await runNative('cargo',['test','--manifest-path',path.join(root,'src-tauri/Cargo.toml'),'--locked','--lib','--no-run','--message-format=json'],process.env,180000);
  assert.equal(build.status,0,build.stderr);
  const artifacts = build.stdout.split('\n').filter(Boolean).map(JSON.parse).filter(record=>record.reason==='compiler-artifact'&&record.target.name==='bilikara_app'&&record.executable);
  assert.equal(artifacts.length,1);
  const home=mkdtempSync(path.join(root,'.tmp/native web login '));
  const output=process.env.BILIKARA_TEST_WEB_LOGIN_EVIDENCE;
  if(output)mkdirSync(output,{recursive:true});
  let fixture,display,wm,app,release;
  t.after(async()=>{release?.();for(const owned of [app,wm,display])if(owned)await owned.terminate();if(fixture)await fixture.close();rmSync(home,{recursive:true,force:true});});
  let requested=false,probe,after,download=false;
  fixture=await localServer(async(request,body)=>{
    const url=new URL(request.url,'http://account.bilibili.com');
    assert.equal(url.hostname,'account.bilibili.com','test proxy must never forward a request');
    if(url.pathname==='/probe'){probe=body;return {data:{ok:true}};}
    if(url.pathname==='/after'){after=body;return {data:{ok:true}};}
    if(url.pathname==='/finish'){
      requested=true;await new Promise(resolve=>{release=resolve;});
      return {headers:{'Set-Cookie':['SESSDATA=synthetic-webview; Domain=.bilibili.com; Path=/; HttpOnly','bili_jct=synthetic-csrf; Domain=.bilibili.com; Path=/']},data:{ok:true}};
    }
    if(url.pathname==='/fixture.apk'){download=true;return {headers:{'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename=fixture.apk'},rawBody:Buffer.from('fixture only')};}
    if(url.pathname==='/empty')return {headers:{'Content-Type':'text/html'},rawBody:Buffer.from('<!doctype html><title>Empty fixture</title>')};
    assert.equal(url.pathname,'/login');
    return {headers:{'Content-Type':'text/html'},rawBody:Buffer.from(`<!doctype html><html><meta charset="utf-8"><style>body{font:20px sans-serif;padding:40px;background:#fff8ef;color:#333}h1{font-size:26px}section{padding:24px;border:1px solid #ccc;border-radius:14px}button{padding:12px}</style><h1>bilikara · isolated login fixture</h1><section>Local fixture only — no real account or credentials.<p>Testing native HttpOnly cookie transfer, denied IPC and ephemeral storage.</p></section><script>
(async()=>{
 let denied='';try{await window.__TAURI__.core.invoke('open_bilibili_login')}catch(error){denied=String(error)}
 const anchor=document.createElement('a');anchor.href='/fixture.apk';anchor.download='fixture.apk';document.body.append(anchor);anchor.click();
 await fetch('/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({denied,httpOnlyVisible:document.cookie.includes('SESSDATA')})});
 await fetch('/finish');
 await fetch('/after',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({httpOnlyVisible:document.cookie.includes('SESSDATA'),csrfVisible:document.cookie.includes('bili_jct=synthetic-csrf')})});
})();</script></html>`)};
  });
  const env={...isolatedEnvironment(home),PATH:process.env.PATH,WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS:'1',BILIKARA_TEST_WEB_LOGIN_PROXY:fixture.base};
  display=new CapturedProcess([tools.Xvfb,'-displayfd','1','-screen','0','1200x900x24','-nolisten','tcp'],home,env);
  const number=await display.waitForOutput((name,line)=>name==='stdout'&&/^\d+\s*$/.test(line)?line.trim():null,10);assert.ok(number);env.DISPLAY=`:${number}`;
  wm=new CapturedProcess([tools.openbox],home,env);
  app=new CapturedProcess([artifacts[0].executable,'--exact','bilibili_login::native_ephemeral_login_window_reads_http_only_cookies_and_reopens_cleanly','--ignored','--nocapture'],home,env);
  await waitFor(()=>{assert.equal(app.exited,false,app.output.stderr);return requested&&probe;},'native login fixture must load and deny IPC',30000);
  assert.match(probe.denied,/not allowed|denied/i,'official page must not receive native command capability');assert.equal(probe.httpOnlyVisible,false);
  if(output){
    const shot=await runNative(tools.scrot,[path.join(output,'native-fixture-login.png')],env,10000,home);assert.equal(shot.status,0,shot.stderr);
  }
  release();assert.equal(await app.waitForExit(30),true,app.output.stderr);assert.equal(app.process.exitCode,0,app.output.stdout+app.output.stderr);
  assert.match(app.output.stdout,/1 passed; 0 failed/);
  assert.deepEqual(after,{httpOnlyVisible:false,csrfVisible:true},'only the native adapter can read the HttpOnly session');
  assert.equal(download,true,'browser attempted the fixture download');
  function files(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]);}
  assert.equal(files(home).some(file=>file.endsWith('.apk')),false,'native window must cancel downloads');
  if(output)writeFileSync(path.join(output,'native-window-result.json'),JSON.stringify({realTauri:true,engine:'Linux WebKitGTK',syntheticFixture:true,httpOnlyNativeRead:true,ipcDenied:true,downloadCancelled:true,reopenedStoreEmpty:true,windowsTested:false},null,2));
});
