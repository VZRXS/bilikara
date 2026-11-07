// Shipped Host and bridge JS over real HTTP/media. Native OS launch is a fixture.
import assert from 'node:assert/strict';
import test,{before} from 'node:test';
import {readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {root,runNative} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost,isolatedEnvironment} from './native_host_support.mjs';
let binary;
before(async()=>{binary=await buildNativeAlpha();},{timeout:300000});
for(const engine of [chromium,webkit])for(const platform of ['ios','android'])test(`${engine.name()} ${platform} detail/rating video tap and keyboard handoff [BILIBILI-EXTERNAL-LINK]`,{timeout:90000},async t=>{
  let page,browser;const errors=[],consoleErrors=[],httpErrors=[];
  const evidence=process.env.BILIKARA_IOS_PLAYBACK_EVIDENCE;
  // Register before teardown so failed CI cases retain the live page too.
  t.after(async()=>{
    if(!evidence||!page||page.isClosed())return;
    mkdirSync(evidence,{recursive:true});const name=`bilibili-link-${engine.name()}-${platform}`;
    await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});
    const observation=await page.evaluate(()=>({current:state.data?.current_item?.id,
      currentBvid:state.data?.current_item?.bvid,previous:state.data?.session_played?.map(({item_id,bvid,page})=>({item_id,bvid,page})).slice(-3),
      activeTab:state.ratingPromptActiveTab,previousDisabled:document.querySelector('[data-rating-tab="previous"]')?.disabled,
      requests:videoRequests.map(({action,url})=>({action,url}))}));
    const metadata={commit:process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
      workingTreeModified:Boolean(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim()),
      engine:engine.name(),version:browser.version(),os:process.platform,architecture:process.arch,
      fixture:'native-alpha-authoritative-history-live-SSE',nativeLaunch:'fixture; DEVICE-UNVERIFIED',
      evidenceClass:'BROWSER-TESTED',observation,errors,consoleErrors,httpErrors};
    writeFileSync(path.join(evidence,name+'.json'),JSON.stringify(metadata,null,2)+'\n');
  });
  const home=ownedDirectory('Bilibili video browser');t.after(()=>rmSync(home,{recursive:true,force:true}));
  const files=[];
  for(const [source,name]of [['video-reordered-start.mp4','video.mp4'],['audio.m4a','audio.m4a']]){
    const file=path.join(home,name);files.push(file);
    const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-stream_loop','-1','-i',path.join(root,'tests/fixtures/bbdown',source),'-t','60','-c','copy',file],process.env,30000);
    assert.equal(result.status,0,result.stderr);
  }
  const environment={...isolatedEnvironment(home),BILIKARA_NATIVE_FIXTURE_EXTERNAL_LINKS:'1'};
  const host=await RunningHost.start(binary,home,[home,path.join(root,'static'),...files,'3'],environment,true);t.after(()=>host.close());
  browser=await engine.launch(engine===chromium?{args:['--autoplay-policy=no-user-gesture-required']}:{});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:393,height:844},hasTouch:true});
  await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  await context.addInitScript(()=>{
    localStorage.setItem('bilikara.update.automatic','false');window.videoRequests=[];window.videoOpenFailure=false;window.videoHold=false;
    window.BilikaraHostPlatform={postMessage(raw){const r=JSON.parse(raw);
      if(r.action==='open-bilibili-video'){videoRequests.push(r);if(videoHold)return;}
      queueMicrotask(()=>BilikaraHostPlatform.onmessage({data:JSON.stringify({id:r.id,ok:!videoOpenFailure,data:{opened:true}})}));
    }};
    window.webkit={messageHandlers:{bilikaraPlatform:{postMessage(raw){const r=JSON.parse(raw);
      if(r.action==='open-bilibili-video'){videoRequests.push(r);if(videoHold)return;}
      if(r.id>0)queueMicrotask(()=>BilikaraIosPlatform._receive({...r,ok:r.action!=='sync-dock'&&!videoOpenFailure,data:{opened:true}}));
    }}}};
  });
  if(platform==='ios')await context.addInitScript(readFileSync(new URL('../static/ios-platform.js',import.meta.url),'utf8').replace('"__BILIKARA_IOS_ORIGIN__"',JSON.stringify(host.base)));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==host.base)return route.abort();
    if(['/', '/index.html'].includes(url.pathname)){
      const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"',`data-host-platform="${platform}"`)});
    }
    return route.continue();
  });
  page=await context.newPage();page.on('pageerror',e=>{if(errors.length<64)errors.push(e.message);});
  page.on('console',message=>{if(consoleErrors.length<64&&['warning','error'].includes(message.type()))consoleErrors.push(message.text().replace(/https?:\/\/[^\s)]+/g,'[url]').slice(0,500));});
  page.on('response',response=>{if(httpErrors.length<64&&response.status()>=400)httpErrors.push({path:new URL(response.url()).pathname,status:response.status()});});
  await page.goto(host.base);
  await page.waitForFunction(()=>state.hasValidStateResponse&&state.hostPlaybackSession?.phase==='playing'
    &&state.data.session_played.some(item=>item.item_id==='fixture-first'));
  const first=await host.api('/api/state');
  assert.equal(first.current_item.bvid,'BV17x411w7KC');
  await host.api('/api/player/next',{playback_generation:first.playback_generation});
  await page.waitForFunction(()=>state.data.current_item.id==='fixture-second'&&state.hostPlaybackSession?.phase==='playing'
    &&state.hostPlaybackSession.playbackGeneration===state.data.playback_generation
    &&state.data.session_played.some(item=>item.item_id==='fixture-first'));
  await page.evaluate(()=>{window.originalVideoPair=[state.hostPlaybackSession.video,state.hostPlaybackSession.audio];});
  const base='https://www.bilibili.com/video/BV1yyjzzCEQn';
  await page.evaluate(()=>{initSearchDetailController();searchDetailController.open({bvid:'BV1yyjzzCEQn',url:'https://www.bilibili.com/video/BV1yyjzzCEQn',page:2,title:'External video fixture'});});
  const detail=page.locator('[data-song-detail-bilibili-link]');
  const open=async(locator,keyboard=false)=>{
    const count=await page.evaluate(()=>videoRequests.length);
    if(keyboard){await locator.focus();await locator.press('Enter');}else await locator.tap();
    await page.waitForFunction(count=>videoRequests.length===count+1,count);
    await page.waitForFunction(()=>!document.querySelector('.song-detail-bilibili-link[aria-busy="true"], .rating-link[aria-busy="true"]'));
    assert.equal(await page.evaluate(()=>videoRequests.length),count+1);
    assert.equal(new URL(page.url()).origin,host.base);
    assert.equal(await page.evaluate(()=>originalVideoPair[0]===state.hostPlaybackSession.video&&originalVideoPair[1]===state.hostPlaybackSession.audio),true);
  };
  await open(detail);await open(detail,true);
  assert.equal(await page.evaluate(()=>videoRequests[0].url),base+'?p=2');
  await page.evaluate(()=>{
    searchDetailController.close();
    openRatingPrompt(state.data.current_item,{manual:true});
  });
  const rating=page.locator('.rating-modal'),link=rating.locator('.rating-link');
  await open(link);await open(link,true);
  await host.api('/api/session-users/add',{name:'Background fixture'});
  await page.waitForFunction(()=>state.data.session_users.includes('Background fixture'));
  await rating.locator('[data-rating-tab="previous"]').click();await open(link);
  assert.equal(await page.evaluate(()=>videoRequests.at(-1).url),'https://www.bilibili.com/video/BV17x411w7KC?p=3');
  await rating.locator('[data-rating-tab="current"]').click();
  await page.evaluate(()=>{videoHold=true;});
  const pendingCount=await page.evaluate(()=>videoRequests.length);
  await link.tap();await page.waitForFunction(()=>document.querySelector('.rating-link').getAttribute('aria-busy')==='true');
  await link.evaluate(node=>node.click());
  assert.equal(await page.evaluate(()=>videoRequests.length),pendingCount+1,'duplicate pending activation is ignored');
  await page.evaluate(platform=>{
    videoHold=false;const r=videoRequests.at(-1);
    if(platform==='ios')BilikaraIosPlatform._receive({...r,ok:true,data:{opened:true}});
    else BilikaraHostPlatform.onmessage({data:JSON.stringify({id:r.id,ok:true,data:{opened:true}})});
  },platform);
  await page.waitForFunction(()=>!document.querySelector('.rating-link').hasAttribute('aria-busy'));
  await page.evaluate(()=>{videoOpenFailure=true;});await open(link);
  assert.equal(await rating.isVisible(),true);
  await page.waitForFunction(()=>document.querySelector('#app-toast')?.textContent?.length>0);
  // This final check is a scoped renderer input, not a fake backend history.
  const unsupportedLinks=await page.evaluate(()=>{state.ratingPromptItems.current={...state.ratingPromptItems.current,bvid:'youtube-id',url:'https://youtube.com/watch?v=abcdef',original_url:'https://youtube.com/watch?v=abcdef'};renderRatingPromptContent();return document.querySelectorAll('.rating-modal .rating-link').length;});
  assert.equal(unsupportedLinks,0);
  assert.deepEqual(errors,[]);
});
