import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {artifacts} from '../scripts/build_webview83.mjs';
import {historicChromium} from './historic_chromium_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';
const executable=process.env.BILIKARA_TEST_CHROMIUM83;
test('WebView 83 generated syntax/layout assets are reproducible; pinned vendor DSP is unchanged', async()=>{
  for(const [name,output] of await artifacts()) assert.equal(readFileSync(new URL('../static/'+name,import.meta.url),'utf8'),output,name);
});
test('WebView 83 generation has an explicit portable LF/CRLF text boundary', async t => {
  const directory=mkdtempSync(path.join(tmpdir(),'bilikara-webview83-crlf-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const expected=await artifacts();
  const names=['index.html','controller.html','vendor/signalsmith-stretch/SignalsmithStretch.js',
    ...Array.from(expected.keys()).filter(name=>name.startsWith('compat83/')).map(name=>name.slice(9))];
  for(const name of names) {
    const destination=path.join(directory,name);mkdirSync(path.dirname(destination),{recursive:true});
    writeFileSync(destination,readFileSync(new URL('../static/'+name,import.meta.url),'utf8').replace(/\r\n|\r/g,'\n').replace(/\n/g,'\r\n'),'utf8');
  }
  assert.deepEqual(await artifacts(directory),expected);
});
test('actual Chromium 83 loads the authenticated shared Host, missing APIs, layout and real animation completion', {
  skip:!executable&&'Set BILIKARA_TEST_CHROMIUM83; a modern browser cannot qualify this test',timeout:300000,
},async t=>{
  const home=mkdtempSync(path.join(tmpdir(),'bilikara-webview83-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const binary=await buildNativeAlpha();
  const host=await RunningHost.start(binary,home,[home,path.resolve('static')],isolatedEnvironment(home),true);t.after(()=>host.close());
  const browser=await historicChromium(t,executable), {send,evaluate,wait,exceptions}=browser;
  const ua=await evaluate('navigator.userAgent');assert.match(ua,/Chrome\/83\./,'Require the real historic engine');
  // The previous logical assignments fail during parsing, before a polyfill can run.
  for(const entry of ['index.html','controller.html','remote.html']) {
    for(const match of readFileSync('static/'+entry,'utf8').matchAll(/<script[^>]+src="\/([^"]+)"/g)) {
      const result=await send('Runtime.compileScript',{expression:readFileSync('static/'+match[1],'utf8'),sourceURL:match[1],persistScript:false});
      assert.equal(result.exceptionDetails,undefined,match[1]+': '+JSON.stringify(result.exceptionDetails));
    }
  }
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(function(){var Native=ResizeObserver;window.fixtureResizeObservers=[];window.ResizeObserver=function(callback){var observer=new Native(callback),targets=new Set(),observe=observer.observe.bind(observer),unobserve=observer.unobserve.bind(observer),disconnect=observer.disconnect.bind(observer);observer.observe=function(node){targets.add(node);return observe(node)};observer.unobserve=function(node){targets.delete(node);return unobserve(node)};observer.disconnect=function(){targets.clear();return disconnect()};fixtureResizeObservers.push(targets);return observer};window.ResizeObserver.prototype=Native.prototype})()`});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:'try{localStorage.setItem("bilikara.update.automatic","false")}catch(e){}'});
  await send('Emulation.setDeviceMetricsOverride',{width:700,height:800,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:host.bootstrapUrl+'?webviewMode=legacy'});
  try { await wait('typeof state!=="undefined"&&state.hasValidStateResponse'); } catch (error) { throw new Error(error.message+' '+JSON.stringify({exceptions, page:await evaluate('[location.pathname,document.body.innerText.slice(0,1200)]')})); }
  assert.deepEqual(await evaluate('[document.documentElement.dataset.webviewMode, BilikaraWebViewCompatibility.engine,typeof AbortSignal.timeout,typeof Object.hasOwn,typeof Array.prototype.at,typeof String.prototype.replaceAll]'),['legacy',83,'undefined','function','function','function']);
  await wait('Array.from(document.querySelectorAll("link[rel=stylesheet]")).every(function(link){return link.href.includes("/compat83/")&&!!link.sheet})');
  // Exercise cancellation and completion with real old Web Animations, no fake timer.
  assert.deepEqual(await evaluate(`(async function(){var n=document.createElement('div');document.body.appendChild(n);var a=n.animate([{opacity:0},{opacity:1}],{duration:50});var tracked=n.getAnimations().indexOf(a)!==-1;await a.finished;var settled=n.getAnimations().length===0;var b=n.animate([],{duration:1000});var cancelled=b.finished.then(function(){return false},function(e){return e.name==='AbortError'});b.cancel();var result=await cancelled;n.remove();return [tracked,settled,result]})()`),[true,true,true]);
  assert.deepEqual(await evaluate(`(function(){var rejected=false;try{'x'.replaceAll(/x/,'y')}catch(e){rejected=true}return ['a+a'.replaceAll('+','$&!'),'ab'.replaceAll('', '-'),'aa'.replaceAll('a',function(m,i){return i}),rejected]})()`),['a+!a','-a-b-','01',true]);
  assert.equal(await evaluate(`(async function(){var module=await import('/vendor/signalsmith-stretch/SignalsmithStretch83.js');return typeof module.default})()`),'function');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.app-shell')).display`),'grid');
  await evaluate(`document.querySelector('[data-session-choice="continue"]')?.click()`);
  await evaluate(`document.querySelector('#remote-mini-trigger').click()`);
  await wait('document.getElementById("remote-popover-qr-image").naturalWidth>0');
  assert.ok(await evaluate('document.body.innerText.length>100'));
  assert.deepEqual(await evaluate(`(function(){var n=document.createElement('div'),child=document.createElement('button');child.onclick=function(){child.dataset.clicked='yes'};n.append(child);n.replaceChildren('before',child);child.click();return [n.textContent,child.dataset.clicked,n.lastChild===child]})()`),['before','yes',true]);
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await wait('getComputedStyle(document.querySelector(".android-host-dock")).display==="grid"');
  assert.equal(await evaluate(`(function(){var rows=Array.from(document.querySelectorAll('.android-host-dock>button')).map(function(n){return n.getBoundingClientRect()});return rows.length===5&&rows.every(function(r){return r.width>0&&r.height>=44&&r.x>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&Math.abs(r.y-rows[0].y)<1})})()`),true,'all five navigation targets must be visible in one row, without scrolling them into view');
  await wait(`(function(){var n=document.querySelector('.android-host-dock>button'),a=n.children[0].getBoundingClientRect(),b=n.children[1].getBoundingClientRect();return Math.abs(b.top-a.bottom-3)<1})()`);
  await evaluate(`var cover=document.createElement('div');cover.className='song-detail-cover';cover.style.width='160px';document.body.appendChild(cover)`);
  await wait('Math.abs(cover.getBoundingClientRect().height-90)<1');
  await evaluate(`cover.style.width='320px';window.dispatchEvent(new Event('resize'))`);
  await wait('Math.abs(cover.getBoundingClientRect().height-180)<1');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-shell")).animationName'),'none');
  await evaluate(`document.querySelector('[data-android-page="queue"]').click()`);
  await wait('document.documentElement.dataset.hostPage==="queue"');
  await send('Emulation.setDeviceMetricsOverride',{width:320,height:720,deviceScaleFactor:1,mobile:true});
  for (const language of ['zh','en','ja']) {
    await evaluate('setLanguage('+JSON.stringify(language)+')');await evaluate('document.fonts.ready');
    await wait(`(function(){var rows=Array.from(document.querySelectorAll('.android-host-dock>button')).map(function(n){return n.getBoundingClientRect()});return rows.length===5&&rows.every(function(r){return r.width>0&&r.height>=44&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&Math.abs(r.y-rows[0].y)<1})})()`);
  }
  await evaluate(`setLanguage('zh');document.querySelector('[data-android-page="playback"]').click();state.eventSource?.close();fetchState=async()=>{}`);
  await wait('document.documentElement.dataset.hostPage==="playback"');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  assert.equal(await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'),false);
  const titleModes=await evaluate(`(function(){
    var n=elements.currentTitle,track=elements.currentTitleText;
    track.textContent='短标题';measurePersistentStage();
    var s=getComputedStyle(track),c=document.createElement('canvas').getContext('2d');
    c.font=s.fontWeight+' '+s.fontSize+' '+s.fontFamily;
    var w=n.clientWidth,word='W'.repeat(Math.max(1,Math.floor(w*.58/c.measureText('W').width)));
    return ['春'.repeat(Math.floor(w*1.35/c.measureText('春').width)),[word,word,word].join(' '),'很长的歌曲标题 gypqj '.repeat(40)].map(function(text){
      track.textContent=text;measurePersistentStage();
      return {two:n.classList.contains('is-two-line'),loop:n.classList.contains('is-text-marquee-loop'),animation:getComputedStyle(track).animationName};
    });
  })()`);
  assert.deepEqual(titleModes,[{two:true,loop:false,animation:'none'},
    {two:false,loop:false,animation:'host-current-title-marquee'},
    {two:false,loop:true,animation:'text-marquee-loop'}]);
  const positionBefore=await evaluate('getComputedStyle(elements.currentTitleText).transform');
  await evaluate('new Promise(function(resolve){setTimeout(resolve,180)})');
  assert.notEqual(await evaluate('getComputedStyle(elements.currentTitleText).transform'),positionBefore,'The genuine old engine actually advances the title animation');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await evaluate('getComputedStyle(elements.currentTitleText).animationName'),'none');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  assert.deepEqual(await evaluate(`(function(){var n=document.getElementById('player-fullscreen-button'),r=n.getBoundingClientRect();return [r.width,r.height,getComputedStyle(n).borderRadius,getComputedStyle(document.getElementById('player-fullscreen-label')).display]})()`),[44,44,'14px','none']);
  if(process.env.BILIKARA_ANDROID_UI_SCREENSHOTS){
    const {data}=await send('Page.captureScreenshot',{format:'png'});
    const output=path.resolve(process.env.BILIKARA_ANDROID_UI_SCREENSHOTS);mkdirSync(output,{recursive:true});
    writeFileSync(path.join(output,'android-chromium83-long.png'),Buffer.from(data,'base64'));
  }
  await evaluate('cover.remove()');
  await wait('fixtureResizeObservers.every(function(targets){return !targets.has(cover)})');
  await evaluate(`window.dispatchEvent(new Event('pagehide'))`);
  assert.equal(await evaluate(`document.querySelector('.android-host-dock>button>span').style.marginTop`),'','leaving the page restores scoped spacing');
  assert.equal(await evaluate('cover.style.height'),'','leaving the page restores scoped aspect geometry');
  assert.deepEqual(exceptions.map(e=>e.exception?.description||e.text),[]);
});
