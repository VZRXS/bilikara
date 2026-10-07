// Offline native decode + actual desktop Host + shared Host/Remote UI.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { webkit } from 'playwright';
import { root, runNative } from './desktop_construction_support.mjs';
import { buildNativeHost } from './native_runtime_artifacts.mjs';
import { HttpClient, RunningHost, isolatedEnvironment, waitFor } from './native_host_support.mjs';
import { localCertificate } from './local_tls_certificate.mjs';
import { videoFixture } from './video_service_fixture.mjs';

mkdirSync(path.join(root,'.tmp'),{recursive:true});
const evidence = process.env.BILIKARA_TEST_AUTO_VOLUME_EVIDENCE || mkdtempSync(path.join(root, '.tmp/automatic-volume-'));
mkdirSync(evidence, { recursive: true });
const companion = process.env.BILIKARA_TEST_LIBAV_COMPANION;
let prepared;
async function timingFixtures(folder) {
  // Stream-copy only: timestamp quantization changes no encoded samples.
  // An independent oracle remains the original 12s/48kHz sine corpus.
  for (const [name, expression] of [
    ['aac-quantized.m4a','round(PTS*TB*1000)/(TB*1000)'],
    ['aac-gap.m4a','PTS+not(not(floor(N/4)))*0.01/TB'],
    ['aac-overlap.m4a','PTS-not(not(floor(N/4)))*0.01/TB'],
  ]) {
    const filter=`setts=pts=${expression}:dts=${expression.replaceAll('PTS','DTS')}`;
    const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',path.join(folder,'aac-48000.m4a'),
      '-map','0:a:0','-c:a','copy','-bsf:a',filter,'-movflags','+faststart',path.join(folder,name)],process.env,30000);
    assert.equal(result.status,0,result.stderr);
  }
}
async function fixtures() {
  return prepared ||= (async () => {
    assert.ok(companion, 'Declare the actual prepared BILIKARA_TEST_LIBAV_COMPANION; no mocked loudness');
    const folder = path.join(evidence, 'fixtures'); mkdirSync(folder, { recursive: true });
    if (process.env.BILIKARA_TEST_REUSE_AUDIO_FIXTURES === '1') { await timingFixtures(folder); return folder; }
    const cases = [
      ['aac-44100.m4a', 44100, 2, 'aac', 12, 1], ['aac-48000.m4a', 48000, 1, 'aac', 12, 1],
      ['flac-96000.flac', 96000, 2, 'flac', 12, 1], ['opus-48000.mp4', 48000, 2, 'libopus', 12, 1],
      ['silence.m4a', 48000, 2, 'aac', 2, 0], ['short.m4a', 48000, 2, 'aac', 0.1, 1],
      ['surround.m4a', 48000, 6, 'aac', 2, 1], ['long.m4a', 48000, 2, 'aac', 1200, 1],
      ['reference.m4a', 48000, 2, 'aac', 90, 1], ['louder.m4a', 48000, 2, 'aac', 90, 10 ** (4 / 20)],
      ['quieter.m4a', 48000, 2, 'aac', 90, 10 ** (-4 / 20)],
    ];
    const oracle = {};
    for (const [name, rate, channels, codec, seconds, gain] of cases) {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=${rate}`, '-t', String(seconds), '-af', `volume=${gain}`, '-ac', String(channels), '-c:a', codec];
      if (!name.endsWith('.flac')) args.push('-movflags', '+faststart');
      const result = await runNative('ffmpeg', [...args, path.join(folder, name)], process.env, 120000);
      assert.equal(result.status, 0, result.stderr);
      if (['aac-44100.m4a', 'aac-48000.m4a', 'flac-96000.flac', 'opus-48000.mp4', 'reference.m4a', 'louder.m4a', 'quieter.m4a'].includes(name)) {
        const check = await runNative('ffmpeg', ['-hide_banner', '-i', path.join(folder, name), '-af', 'ebur128=peak=none', '-f', 'null', '-'], process.env, 120000);
        assert.equal(check.status, 0, check.stderr);
        const values = [...check.stderr.matchAll(/I:\s*(-?[\d.]+) LUFS/g)]; assert.ok(values.length);
        oracle[name] = Number(values.at(-1)[1]);
      }
    }
    const bytes = readFileSync(path.join(folder, 'aac-48000.m4a'));
    writeFileSync(path.join(folder, 'truncated.m4a'), bytes.subarray(0, Math.floor(bytes.length * 0.8)));
    writeFileSync(path.join(folder, 'invalid.m4a'), 'invalid offline audio');
    writeFileSync(path.join(folder, 'oracle.json'), JSON.stringify(oracle, null, 2));
    const video = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '90', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(folder, 'video.mp4')], process.env, 120000);
    assert.equal(video.status, 0, video.stderr);
    await timingFixtures(folder);
    return folder;
  })();
}

test('real native compressed PCM loudness, failure/cancellation and artifact reuse', { timeout: 300000 }, async () => {
  const folder = await fixtures();
  const build = await runNative('cargo', ['test', '--manifest-path', path.join(root, 'rust-runtime/Cargo.toml'), '--locked', '--target', 'host-tuple', '--features', 'native-host', '--lib', '--no-run', '--message-format=json'], process.env, 300000);
  const messages = build.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(build.status, 0, messages.filter(m => m.reason === 'compiler-message').map(m => m.message.rendered).join('\n'));
  const binary = messages.find(m => m.reason === 'compiler-artifact' && m.target.name === 'bilikara_runtime' && m.profile.test)?.executable;
  assert.ok(binary);
  const env = { ...process.env, BILIKARA_TEST_LOUDNESS_FIXTURES: folder };
  for (const name of ['experimental_libav::pcm::tests::real_compressed_pcm_integrated_loudness', 'native_host::automatic_volume::tests::artifact_fact_reuse_and_replacement']) {
    const result = await runNative(binary, ['--exact', name, '--ignored', '--nocapture'], env, 60000);
    writeFileSync(path.join(evidence, name.startsWith('experimental') ? 'analysis.txt' : 'reuse.txt'), result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

async function startFixture(folder, t, { deferPendingAudio = false } = {}) {
  const home = mkdtempSync(path.join(evidence, 'native-'));
  const data = path.join(home, 'data'); mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, '.bilikara-desktop-rust-preview'), 'desktop-rust-preview-v1\n');
  for (const [name, value] of Object.entries({ 'native-library-defaults.json': {schema_version:1}, 'gatcha_uids.json': {schema_version:2,uids:[],profiles:{}}, 'gatcha_cache.json': {schema_version:3,uids:{},profiles:{}} })) writeFileSync(path.join(data, name), JSON.stringify(value));
  const certs = await localCertificate(path.join(home, 'certs'), ['api.bilibili.com', 'fixture.bilivideo.com']);
  const titles = ['晨光练习', '海风练习', '星空练习'];
  const bvids = ['BV1xx411c7mD', 'BV1z84y1p7oS', 'BV1tPC2BEEjq'];
  let releasePending;
  const pending = deferPendingAudio ? new Promise(resolve => { releasePending = resolve; }) : Promise.resolve();
  const pendingRequests = [];
  const provider = await videoFixture(async (raw, headers) => {
    const url = new URL(raw, 'https://api.bilibili.com');
    if (['/x/web-interface/view','/x/web-interface/wbi/view'].includes(url.pathname)) {
      const index = Math.max(0, bvids.indexOf(url.searchParams.get('bvid')));
      return {code:0,data:{aid:index+1,bvid:bvids[index],title:titles[index],pic:'',owner:{mid:42,name:'合成音频'},pages:[{page:1,cid:10*(index+1)+1,duration:90,part:'on vocal'},{page:2,cid:10*(index+1)+2,duration:90,part:'off vocal'}]}};
    }
    if (['/x/player/wbi/playurl', '/x/player/playurl'].includes(url.pathname)) {
      const cid = Number(url.searchParams.get('cid'));
      const audio = cid < 20 ? (cid === 12 ? 'louder' : 'reference') : cid < 30 ? 'louder' : 'quieter';
      return {code:0,data:{quality:64,dash:{duration:90,video:[{id:64,codecid:7,bandwidth:100000,baseUrl:'https://fixture.bilivideo.com/video.mp4',mimeType:'video/mp4',codecs:'avc1.64001e'}],audio:[{id:30280,bandwidth:128000,baseUrl:`https://fixture.bilivideo.com/${audio}.m4a`,mimeType:'audio/mp4',codecs:'mp4a.40.2'}]}}};
    }
    if (['/video.mp4','/reference.m4a','/louder.m4a','/quieter.m4a'].includes(url.pathname)) {
      if (deferPendingAudio && url.pathname !== '/reference.m4a' && url.pathname !== '/video.mp4') {
        pendingRequests.push(url.pathname);
        await pending;
      }
      let body = readFileSync(path.join(folder, url.pathname.slice(1))); const responseHeaders = {'Accept-Ranges':'bytes'}; let status=200;
      if (headers.range) {const [,start,end] = headers.range.match(/^bytes=(\d+)-(\d*)$/); const first=Number(start),last=end?Number(end):body.length-1;responseHeaders['Content-Range']=`bytes ${first}-${last}/${body.length}`;body=body.subarray(first,last+1);status=206;}
      return {fixtureResponse:{status,rawBody:body,headers:responseHeaders}};
    }
    if (url.pathname === '/x/web-interface/nav') return {code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/bfs/wbi/'+'b'.repeat(32)+'.png'}}};
    writeFileSync(path.join(evidence,'unhandled-provider.txt'), raw + '\n', {flag:'a'});
    return {fixtureResponse:{status:503,data:{error:'offline synthetic provider only'}}};
  }, certs);
  t.after(async () => { releasePending?.(); await provider.close(); });
  const env = {...isolatedEnvironment(home), ...provider.environment, BILIKARA_LIBAV_COMPANION:companion, NO_PROXY:'127.0.0.1,localhost', no_proxy:'127.0.0.1,localhost', BILIKARA_CF_API_URL:'http://127.0.0.1:1', BILIKARA_CATALOG_SHEETS_URL:'http://127.0.0.1:1/disabled.csv'};
  const executable = await buildNativeHost();
  const host = await RunningHost.start(executable, home, ['--headless','--port','0','--data-dir',data,'--static-dir',path.join(root,'static')], env);
  t.after(() => host.close());
  await host.api('/api/session-users/add',{name:'练习者'});
  for (const bvid of bvids) await host.api('/api/playlist/add',{url:`https://www.bilibili.com/video/${bvid}`,allow_repeat:true});
  if (!deferPendingAudio) await waitFor(async () => { const state = await host.api('/api/state'); const items=[state.current_item,...state.playlist]; if(items.some(i=>i?.cache_status==='failed')) assert.fail(JSON.stringify(items.map(i=>({title:i?.title,status:i?.cache_status,message:i?.cache_message})))); return state.current_item?.cache_status === 'ready' && state.playlist.every(i => i.cache_status === 'ready'); }, 'synthetic audio publication', 60000);
  return {host, provider, executable, env, data, home, releasePending, pendingRequests};
}

test('continued session freshly caches and analyzes pending audio after a real Host restart', { timeout: 180000 }, async t => {
  const fixture = await startFixture(await fixtures(), t, { deferPendingAudio: true });
  const { host, executable, home, data, env, releasePending, pendingRequests } = fixture;
  await host.api('/api/player/volume', {volume_percent:50});
  await host.api('/api/player/automatic-volume', {action:'enable',enabled:true});
  await waitFor(() => pendingRequests.length > 0, 'pending media transfer reaches the real downloader');
  const before = await host.api('/api/state');
  assert.ok([before.current_item,...before.playlist].some(item => item.cache_status !== 'ready'));
  assert.equal(before.automatic_volume.enabled, true);
  await host.close(releasePending);
  const restarted = await RunningHost.start(executable, home,
    ['--headless','--port','0','--data-dir',data,'--static-dir',path.join(root,'static')], env);
  t.after(() => restarted.close());
  const restored = await restarted.api('/api/state');
  assert.equal(restored.session_flags.startup_choice_pending, true);
  assert.equal(restored.automatic_volume.enabled, true, 'the setting is persisted across the actual process boundary');
  assert.equal(restored.player_settings.volume_percent, 50, 'restore preserves the current manual volume');
  assert.ok([restored.current_item,...restored.playlist].some(item => item.cache_status !== 'ready'),
    'restored work still needs a fresh download, not a pre-published fixture');
  const requestsBeforeContinue = fixture.provider.requests.length;
  await restarted.api('/api/session/startup-choice', {choice:'continue'});
  await waitFor(async () => {
    const state = await restarted.api('/api/state');
    const items = [state.current_item,...state.playlist];
    assert.ok(items.every(item => item.cache_status !== 'failed'), 'cache restoration must not silently fail');
    return items.every(item => item.cache_status === 'ready') && state.automatic_volume.can_reference;
  }, 'continued pending cache and real whole-audio analysis', 60000);
  assert.ok(fixture.provider.requests.slice(requestsBeforeContinue).some(url => /\/(louder|quieter)\.m4a/.test(url)),
    'the restarted process actually acquires the pending audio');
  const ready = await restarted.api('/api/state');
  const analyses = (await restarted.api('/api/diagnostics/native')).events.filter(event => event.event === 'automatic-volume-analysis');
  assert.ok(analyses.some(event => event.reused === false), 'real PCM execution occurs after restoration');
  await restarted.api('/api/player/automatic-volume', {action:'reference',context:ready.automatic_volume.context});
  await restarted.api('/api/player/next', {playback_generation:(await restarted.api('/api/state')).playback_generation});
  await waitFor(async () => (await restarted.api('/api/state')).automatic_volume.status === 'automatic',
    'pending next-song audio is usable as a real automatic-volume input', 45000);
  assert.ok(Math.abs((await restarted.api('/api/state')).player_settings.volume_percent - 32) <= 1,
    'independent +4dB fixture produces the preserved automatic-volume result after restoration');
  writeFileSync(path.join(evidence,'restored-pending-analysis.json'),JSON.stringify({pendingRequests,
    before:before.automatic_volume,restored:restored.automatic_volume,ready:ready.automatic_volume,analyses},null,2));
});

test('actual desktop Host calibration, local/public authorization and rendered shared dialogs', { timeout: 300000 }, async t => {
  const fixture = await startFixture(await fixtures(), t);
  const { host, provider } = fixture;

  const baseline = await host.api('/api/state');
  assert.equal(baseline.automatic_volume.enabled, false);
  assert.equal(baseline.capabilities.platform, 'desktop');
  await host.api('/api/player/volume', {volume_percent:50});
  // Ordinary LAN Remote receives its own device session, including on loopback.
  const phone = new HttpClient(host.base); await phone.request('/remote');
  await phone.api('/api/remote-identity/register', {name:'手机练习者'});
  for (const action of ['enable','reference','resume']) {
    for (const headers of [{},{'X-Bilikara-Role':'host','X-Bilikara-Origin':'automatic'}]) {
      const result=await phone.request('/api/player/automatic-volume',{action,enabled:true,context:baseline.automatic_volume.context,role:'host',origin:'automatic'},headers);
      assert.equal(result.status,403);
    }
  }
  assert.equal((await phone.request('/api/player/automatic-volume')).status,501);
  const remoteHeaders={Origin:host.base,'Content-Type':'application/json',Cookie:[...phone.cookies].map(([key,value])=>`${key}=${value}`).join('; '),'X-Bilikara-Role':'host'};
  for(const method of ['PUT','PATCH','DELETE']) {
    const response=await fetch(host.base+'/api/player/automatic-volume?role=host',{method,headers:remoteHeaders,body:JSON.stringify({action:'enable',enabled:true})});
    assert.ok(response.status>=400);
  }
  for(const route of ['/api/player/automatic-volume/','/api/automatic-volume','/api/app-state']) assert.ok((await phone.request(route,{command:'automatic_volume',action:'enable',enabled:true})).status>=400);
  assert.equal((await host.api('/api/state')).automatic_volume.enabled,false);
  assert.ok((await phone.request('/api/command',{command:'automatic_volume',enabled:true})).status>=400);
  const epoch='abcdefghijklmnopqrstuv';
  await host.api('/api/internet-remote/peer/open',{peer_id:'volume-public',epoch,profile:'controller'});
  let sequence=0;
  const publicRequest=(kind,body)=>host.request('/api/internet-remote/dispatch',{peer_id:'volume-public',lane:'control',message:JSON.stringify({v:1,lane:'control',epoch,seq:++sequence,id:`123e4567-e89b-42d3-a456-${String(sequence).padStart(12,'0')}`,kind,body})});
  for (const kind of ['player.automatic_volume','player.calibrate_volume','player.resume_automatic','automatic_volume.enable']) assert.ok((await publicRequest(kind,{enabled:true,role:'host'})).status>=400);
  const read=await publicRequest('state.get',{}); assert.equal(read.status,200);
  assert.equal(JSON.parse(read.body).data.data.automatic_volume.enabled,false);
  const forged=await publicRequest('player.set_volume',{volume_percent:55,origin:'automatic'});assert.ok(forged.status>=400);
  const manualPublic=await publicRequest('player.set_volume',{volume_percent:50}); assert.equal(manualPublic.status,200);
  const disabledResponsiveness=[];
  for(let i=0;i<10;i++) {const started=performance.now();await phone.api('/api/player/volume',{volume_percent:i%2?50:51});disabledResponsiveness.push(performance.now()-started);}
  assert.equal((await host.api('/api/diagnostics/native')).events.some(event=>event.event==='automatic-volume-analysis'),false);

  const browser=await webkit.launch({headless:true}); t.after(()=>browser.close());
  const desktopViewport={width:1920,height:1080}, remoteViewport={width:440,height:956};
  const desktop=await browser.newContext({viewport:desktopViewport,locale:'zh-CN'});
  await desktop.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
  const remoteContext=await browser.newContext({viewport:remoteViewport,locale:'zh-CN',hasTouch:true,isMobile:true});
  for (const context of [desktop,remoteContext]) await context.route('**/*',route=>new URL(route.request().url()).origin===host.base?route.continue():route.abort());
  const errors=[], consoleErrors=[], failedResponses=[];
  const page=await desktop.newPage(); const remote=await remoteContext.newPage();
  for(const p of [page,remote]) {p.on('pageerror',error=>errors.push(error.message));p.on('console',message=>{if(message.type()==='error')consoleErrors.push({text:message.text(),location:message.location()});});p.on('response',response=>{if(response.status()>=400)failedResponses.push({url:response.url(),status:response.status()});});}
  t.after(()=>writeFileSync(path.join(evidence,'browser-errors.json'),JSON.stringify({errors,consoleErrors,failedResponses},null,2)));
  const settle=locator=>locator.evaluate(node=>Promise.allSettled(node.getAnimations().map(animation=>animation.finished)));
  await page.goto(host.base+'/'); await page.waitForFunction(()=>typeof state!=='undefined' && state.hasValidStateResponse && state.data.current_item?.cache_status==='ready');
  assert.equal(await page.title(),'bilikara host');
  const tray=page.locator('#stage-controls-toggle');
  if(await tray.isVisible() && await tray.getAttribute('aria-expanded')!=='true')await tray.click();
  await page.locator('#volume-value').click();
  const dialog=page.locator('.volume-adjust-popover');
  await settle(dialog);
  assert.equal(await dialog.locator('[data-auto-status]').isVisible(),true,'Host state stays visible even while automatic volume is off');
  assert.equal(await dialog.locator('[data-auto-status]').textContent(),'已关闭 · 手动音量');
  // Help belongs to the info button, not the setting title or its switch.
  // Wait beyond the shared 160ms hover delay to detect unintended openings.
  for (const [name, target] of [['label', '[data-auto-label]'], ['switch', '.automatic-volume-toggle']]) {
    const box=await dialog.locator(target).boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.waitForTimeout(250);
    await page.screenshot({path:path.join(evidence,`00-host-auto-info-${name}-hover.png`)});
    assert.equal(await page.locator('#host-automatic-volume-help').evaluate(node=>node.matches(':popover-open')),false,
      `Hovering the automatic-volume ${name} must not open help`);
  }
  const infoBounds=await dialog.locator('[data-auto-info]').boundingBox();
  assert.equal(infoBounds.width,32); assert.equal(infoBounds.height,32,'the shared help target stays accessible');
  await page.mouse.move(infoBounds.x+infoBounds.width/2,infoBounds.y+infoBounds.height/2);
  await page.waitForFunction(()=>document.querySelector('#host-automatic-volume-help').matches(':popover-open'));
  await page.keyboard.press('Escape');
  await page.mouse.move(20,20);
  await dialog.locator('[data-auto-info]').focus();
  await page.waitForFunction(()=>document.querySelector('#host-automatic-volume-help').matches(':popover-open'));
  await page.keyboard.press('Escape');
  assert.equal(await dialog.evaluate(node=>node.open),true,'closing help keeps the volume editor open');
  await dialog.locator('.automatic-volume-toggle').click();
  const responsiveness=[];
  for(let i=0;i<10;i++) {
    const before=await host.api('/api/state'); const started=performance.now();
    await phone.api('/api/player/volume',{volume_percent:i%2?50:51});
    responsiveness.push({analysisPending:before.automatic_volume.reference_reason==='analyzing',milliseconds:performance.now()-started});
  }
  await waitFor(async()=>{const state=await host.api('/api/state');return state.automatic_volume.can_reference && state;},'whole current audio measurement',45000);
  const ready=await host.api('/api/state');
  await page.waitForFunction(revision=>state.data.automatic_volume.can_reference && state.data.automatic_volume.context.intent_revision===revision && !document.querySelector('[data-auto-reference]').disabled,ready.automatic_volume.context.intent_revision);
  assert.equal((await host.api('/api/state')).player_settings.volume_percent,50);
  assert.equal((await host.api('/api/state')).automatic_volume.calibrated,false);
  await page.waitForFunction(()=>state.hostPlaybackSession?.video?.currentTime>0.2);
  await settle(dialog);
  await page.screenshot({path:path.join(evidence,'01-host-waiting-reference.png')});
  const waitingGeometry=[];
  for(const [language,theme] of [['en','dark'],['ja','blue'],['zh','light']]) {
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('.volume-adjust-popover').open);
    await page.setViewportSize({width:700,height:600});
    await page.locator('#work-rail-settings').click();
    await page.locator(`#language-switch [data-language=${language}]`).click();
    await page.locator(`#theme-switch [data-theme=${theme}]`).click();
    await page.locator('#work-rail-settings').click();
    if(await tray.isVisible() && await tray.getAttribute('aria-expanded')!=='true')await tray.click();
    await page.locator('#volume-value').click(); await settle(dialog);
    const geometry=await dialog.locator('.automatic-volume-row').evaluate(row=>{
      const box=row.getBoundingClientRect();
      const label=row.querySelector('[data-auto-label]');
      const status=row.querySelector('[data-auto-status]');
      const toggle=row.querySelector('.automatic-volume-toggle').getBoundingClientRect();
      const range=document.createRange(); range.selectNodeContents(label);
      const text=range.getBoundingClientRect(),cell=label.getBoundingClientRect();
      const statusBox=status.getBoundingClientRect();
      const statusRange=document.createRange(); statusRange.selectNodeContents(status);
      const statusText=statusRange.getBoundingClientRect();
      return {statusHidden:status.hidden,statusText:status.textContent,height:box.height,
        statusInside:statusText.left>=statusBox.left && statusText.right<=statusBox.right + 0.1
          && statusText.top>=statusBox.top && statusText.bottom<=statusBox.bottom,
        toggleInRow:toggle.top>=box.top && toggle.bottom<=box.bottom,
        labelInside:text.left>=cell.left && text.right<=cell.right + 0.1
          && text.top>=box.top && text.bottom<=box.bottom};
    });
    assert.equal(geometry.statusHidden,false,'waiting for a reference retains the Host state row');
    const waitingLabels={en:'Waiting for volume reference',ja:'音量の基準設定を待っています',zh:'等待设定音量基准'};
    assert.equal(geometry.statusText,waitingLabels[language]);
    assert.ok(geometry.height<=60 && geometry.toggleInRow && geometry.labelInside && geometry.statusInside,
      'translated title/switch and the separate state row fit without clipping');
    const reference=dialog.locator('[data-auto-reference]');
    assert.equal(await reference.isEnabled(),true);
    const hints={en:'No reference has been set',ja:'基準はまだ設定されていません',zh:'尚未设定基准'};
    const helpText={
      en:'Once the song is cached, adjust the volume to a comfortable level (50–75% is suggested). Select “Set reference” to use the current song and volume as the reference for automatic adjustments to later songs, up to 100%.\nWith auto volume enabled, manual adjustments affect only this song. Selecting “Update reference” affects later songs.',
      ja:'曲のキャッシュが完了したら、音量を快適な大きさに調整してください（目安は 50～75% です）。「基準を設定」を押すと、現在の曲と音量を基準に、以降の曲の音量を自動で調整します。自動調整は最大 100% です。\n自動音量が有効な間、手動調整はこの曲だけに適用されます。「基準を更新」を押すと、以降の曲にも適用されます。',
      zh:'歌曲缓存完成后，将音量调到合适水平（建议 50～75%）。点击「设为基准」后，软件将以当前歌曲和音量建立基准，自动调节后续曲目的音量；自动调整最高为 100%。\n开启自动音量后，手动调节只影响本曲，点击「更新基准」会影响后续歌曲。',
    };
    assert.equal(await reference.getAttribute('title'),hints[language]);
    assert.ok((await reference.getAttribute('aria-label')).includes(hints[language]));
    await dialog.locator('[data-auto-info]').click();
    const help=page.locator('#host-automatic-volume-help');
    await page.waitForFunction(()=>document.querySelector('#host-automatic-volume-help').matches(':popover-open'));
    await settle(help);
    assert.equal(await help.textContent(),helpText[language],'tap/click help explains the workflow without requiring the user to judge analysis completion');
    await page.screenshot({path:path.join(evidence,`01-host-waiting-help-${language}.png`)});
    await page.keyboard.press('Escape');
    const waitingState=await host.api('/api/state');
    assert.equal(waitingState.automatic_volume.calibrated,false,'locale/help changes cannot establish a reference');
    assert.equal(waitingState.player_settings.volume_percent,50);
    waitingGeometry.push({language,theme,...geometry});
    await page.screenshot({path:path.join(evidence,`01-host-waiting-reference-${language}.png`)});
  }
  await page.setViewportSize(desktopViewport); await settle(dialog);
  await page.screenshot({path:path.join(evidence,'01-host-waiting-reference.png')});
  await dialog.locator('[data-auto-reference]').click();
  await page.waitForFunction(()=>state.data.automatic_volume.status==='automatic');
  assert.equal((await host.api('/api/state')).player_settings.volume_percent,50);
  await dialog.locator('[data-auto-info]').click();
  await page.waitForFunction(()=>document.querySelector('#host-automatic-volume-help').matches(':popover-open'));
  await settle(page.locator('#host-automatic-volume-help'));
  await page.screenshot({path:path.join(evidence,'02-host-calibrated-help.png')});
  // Calibration did not add a graph or move media nodes.
  const media=await page.evaluate(()=>({audioVolume:state.hostPlaybackSession?.audio?.volume,graph:!!state.hostPlaybackSession?.audio?.bilikaraVolumeGain}));
  assert.equal(media.graph,false); assert.equal(media.audioVolume,0.5);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await remote.goto(host.base+'/remote');
  await remote.waitForFunction(()=>typeof state!=='undefined' && state.data?.current_item && !state.remoteIdentityChecking);
  await remote.locator('#remote-identity-input').fill('手机试听者');
  await remote.locator('#remote-identity-submit').click();
  await remote.waitForFunction(()=>state.remoteIdentity?.registered);
  await remote.locator('#remote-identity-modal').waitFor({state:'hidden'});
  assert.equal(await remote.title(), 'bilikara remote');
  await remote.locator('#playback-dock').click();
  await settle(remote.locator('.playback-sheet-panel'));
  await remote.locator('#remote-volume-value').click();
  const remoteDialog=remote.locator('.volume-adjust-popover');
  await settle(remoteDialog);
  assert.equal(await remoteDialog.evaluate(node=>node.open),true);
  assert.equal(await remoteDialog.locator('[data-auto-switch]').isVisible(),false);
  assert.equal(await remoteDialog.locator('[data-auto-reference]').isVisible(),false);
  assert.equal(await remoteDialog.locator('[data-auto-resume]').isVisible(),false);
  await remoteDialog.locator('[data-auto-info]').click();
  await remote.waitForFunction(()=>document.querySelector('#remote-automatic-volume-help').matches(':popover-open'));
  await settle(remoteDialog); await settle(remote.locator('#remote-automatic-volume-help'));
  await remote.screenshot({path:path.join(evidence,'03-remote-automatic-help.png')});
  await remote.keyboard.press('Escape');
  await remoteDialog.locator('input[type=number]').fill('65'); await remoteDialog.locator('input[type=number]').press('Enter');
  await remote.waitForFunction(()=>state.data.automatic_volume.status==='manual' && state.data.player_settings.volume_percent===65);
  await remoteDialog.locator('[data-auto-info]').click();
  await settle(remote.locator('#remote-automatic-volume-help'));
  await remote.screenshot({path:path.join(evidence,'04-remote-manual-help.png')});
  const stale=(await host.api('/api/state')).automatic_volume.context;
  await phone.api('/api/player/volume',{volume_percent:66});
  assert.equal((await host.request('/api/player/automatic-volume',{action:'reference',context:stale})).status,409);
  await remote.keyboard.press('Escape'); await remote.keyboard.press('Escape');
  await host.api('/api/player/next',{playback_generation:(await host.api('/api/state')).playback_generation});
  await waitFor(async()=>{const current=await host.api('/api/state');return current.current_item?.title==='海风练习' && current.automatic_volume.status==='automatic' && current;},'next song returns to automatic',45000);
  const next=await host.api('/api/state'); assert.ok(Math.abs(next.player_settings.volume_percent-32)<=1);
  await remote.locator('#remote-volume-value').click(); await remote.waitForFunction(()=>state.data.automatic_volume.status==='automatic');
  await settle(remoteDialog);
  await remote.screenshot({path:path.join(evidence,'05-remote-next-automatic.png')});
  // An unrelated real SSE update preserves a numeric draft and modal focus.
  const draft=remoteDialog.locator('input[type=number]'); await draft.fill('73');
  await host.api('/api/session-users/add',{name:'会场访客'});
  await remote.waitForFunction(()=>state.data.session_users.includes('会场访客'));
  assert.equal(await draft.inputValue(),'73');
  assert.equal(await draft.evaluate(node=>document.activeElement===node),true);
  await remote.keyboard.press('Escape'); await remote.waitForFunction(()=>!document.querySelector('.volume-adjust-popover').open);
  const savedTarget=JSON.parse(readFileSync(path.join(fixture.data,'host-state.json'))).state.automatic_volume.target_lufs;
  await page.locator('#volume-value').click();
  let releaseReference, enteredReference;
  const gate=new Promise(resolve=>{releaseReference=resolve;});
  const entered=new Promise(resolve=>{enteredReference=resolve;});
  await page.route('**/api/player/automatic-volume',async route=>{enteredReference();await gate;await route.continue();});
  await dialog.locator('[data-auto-reference]').click(); await entered;
  assert.equal(await dialog.locator('[data-auto-reference]').getAttribute('aria-busy'),'true');
  await phone.api('/api/player/volume',{volume_percent:66}); releaseReference();
  await dialog.locator('.volume-adjust-error').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('[data-auto-reference]').hasAttribute('aria-busy') && state.data.player_settings.volume_percent===66);
  assert.equal(JSON.parse(readFileSync(path.join(fixture.data,'host-state.json'))).state.automatic_volume.target_lufs,savedTarget);
  await page.unroute('**/api/player/automatic-volume');
  await page.screenshot({path:path.join(evidence,'06-host-stale-reference.png')});
  await dialog.locator('[data-auto-resume]').click();
  await page.waitForFunction(()=>state.data.automatic_volume.status==='automatic' && state.data.player_settings.volume_percent===32);
  await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.querySelector('.volume-adjust-popover').open);
  // Real appearance controls, then actual dialogs/help, for all locales/themes.
  const geometry=[];
  for(const [role,p,width,height] of [['host',page,700,600],['remote',remote,320,640]]) {
    await p.setViewportSize({width,height});
    for(const [language,theme] of [['zh','light'],['en','dark'],['ja','blue']]) {
      if(role==='host') {
        await p.locator('#work-rail-settings').click();
        await p.locator(`#language-switch [data-language=${language}]`).click();
        await p.locator(`#theme-switch [data-theme=${theme}]`).click();
        await p.locator('#work-rail-settings').click();
        if(await p.locator('#stage-controls-toggle').isVisible() && await p.locator('#stage-controls-toggle').getAttribute('aria-expanded')!=='true')await p.locator('#stage-controls-toggle').click();
      } else {
        await p.keyboard.press('Escape');
        await p.waitForFunction(()=>!state.playbackSheetOpen);
        await p.locator('#remote-menu-toggle').click();
        if(await p.locator('#remote-settings-toggle').getAttribute('aria-expanded')!=='true')await p.locator('#remote-settings-toggle').click();
        await p.locator(`#language-switch [data-language=${language}]`).click();
        await p.locator(`#theme-switch [data-theme=${theme}]`).click();
        await p.locator('#remote-menu-toggle').click();
        await p.locator('#playback-dock').click(); await settle(p.locator('.playback-sheet-panel'));
      }
      await p.locator(role==='host'?'#volume-value':'#remote-volume-value').click();
      const popup=p.locator('.volume-adjust-popover'); await settle(popup);
      await popup.locator('[data-auto-info]').click();
      const help=p.locator(`#${role}-automatic-volume-help`); await settle(help);
      const bounds=await help.boundingBox();
      assert.ok(bounds.x>=7 && bounds.y>=7 && bounds.x+bounds.width<=width-7 && bounds.y+bounds.height<=height-7);
      assert.equal(await help.evaluate(node=>node.matches(':popover-open') && node.contains(document.elementFromPoint(node.getBoundingClientRect().x+12,node.getBoundingClientRect().y+12))),true);
      const row=await popup.locator('.automatic-volume-row').boundingBox();
      if(role==='remote')assert.ok(row.height<=32.1,'Remote status fits one row');
      const panel=await popup.evaluate(node=>{
        const box=node.getBoundingClientRect(),form=node.querySelector('form').getBoundingClientRect(),css=getComputedStyle(node);
        const insets=[form.left-box.left-parseFloat(css.borderLeftWidth),box.right-form.right-parseFloat(css.borderRightWidth),form.top-box.top-parseFloat(css.borderTopWidth),box.bottom-form.bottom-parseFloat(css.borderBottomWidth)];
        const buttons=[...node.querySelectorAll('[data-auto-reference], [data-auto-resume]')].filter(button=>!button.hidden).map(button=>{
          const b=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(button);const text=range.getBoundingClientRect();
          return {height:b.height,textInside:text.top>=b.top && text.bottom<=b.bottom && text.left>=b.left && text.right<=b.right};
        });
        const label=node.querySelector('[data-auto-label]'),labelRange=document.createRange();labelRange.selectNodeContents(label);
        const labelBottom=labelRange.getBoundingClientRect().bottom;
        const labelCss=getComputedStyle(label),peer=getComputedStyle(document.querySelector(node.classList.contains('is-remote-volume')?'#remote-volume-panel .panel-tag':'#volume-panel .section-tag'));
        const textStyle=css=>({size:css.fontSize,weight:css.fontWeight,color:css.color,spacing:css.letterSpacing,transform:css.textTransform});
        const status=getComputedStyle(node.querySelector('[data-auto-status]'));
        const accent=css.getPropertyValue('--accent').trim();
        const rgb=/^#[\da-f]{6}$/i.test(accent)?`rgb(${accent.slice(1).match(/../g).map(pair=>Number.parseInt(pair,16)).join(', ')})`:accent;
        return {width:box.width,insets,buttons,overflow:node.scrollWidth>node.clientWidth,trailingTextSpace:form.bottom-labelBottom,labelStyle:textStyle(labelCss),peerStyle:textStyle(peer),accentStatus:status.color===rgb};
      });
      assert.equal(panel.width,232,'keep the existing volume editor width');
      assert.ok(panel.insets.every(inset=>Math.abs(inset-20)<0.1),'all four panel insets stay 20px');
      assert.equal(panel.overflow,false);
      assert.ok(panel.buttons.every(button=>button.height===44 && button.textInside),'translated action text fits ordinary 44px controls');
      assert.deepEqual(panel.labelStyle,panel.peerStyle,'automatic volume and playback setting headings share the same typography');
      assert.equal(panel.labelStyle.size,'12px');assert.equal(panel.labelStyle.weight,'400');
      assert.equal(panel.accentStatus,true,'active automatic status uses the selected theme accent');
      if(role==='remote')assert.ok(panel.trailingTextSpace>=0 && panel.trailingTextSpace<=1,'the last status text aligns to the content edge without extra line-box whitespace');
      geometry.push({role,language,theme,viewport:[width,height],bounds,row,panel});
      await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
      await p.waitForFunction(()=>!document.querySelector('.volume-adjust-popover').open);
    }
  }
  // A real native HTML media-control change follows the same manual command.
  // SSE's automatic application has already left the song automatic, so its
  // volumechange echo did not manufacture a manual override.
  await page.evaluate(()=>{state.hostPlaybackSession.video.volume=0.42;});
  await waitFor(async()=>{const snapshot=await host.api('/api/state');return snapshot.automatic_volume.status==='manual' && snapshot.player_settings.volume_percent===42;},'native volume event reaches AppState');
  await host.api('/api/player/automatic-volume',{action:'resume',context:(await host.api('/api/state')).automatic_volume.context});
  await page.waitForFunction(()=>state.data.automatic_volume.status==='automatic' && Math.abs(state.hostPlaybackSession.video.volume-0.32)<1e-6);
  await page.evaluate(()=>{state.hostPlaybackSession.video.muted=true;});
  await waitFor(async()=>{const snapshot=await host.api('/api/state');return snapshot.player_settings.is_muted && !snapshot.automatic_volume.manual_override;},'native mute is independent');
  // Both views must acknowledge mute before unmuting; an older unmuted SSE
  // snapshot must not satisfy the following wait while the command is pending.
  await page.waitForFunction(()=>state.data.player_settings.is_muted && state.hostPlaybackSession.video.muted);
  await remote.waitForFunction(()=>state.data.player_settings.is_muted);
  await page.evaluate(()=>{state.hostPlaybackSession.video.muted=false;});
  await page.waitForFunction(()=>state.data.automatic_volume.status==='automatic' && !state.data.player_settings.is_muted);
  await remote.waitForFunction(()=>state.data.automatic_volume.status==='automatic' && !state.data.player_settings.is_muted);
  await remote.locator('#remote-volume-value').click(); await settle(remoteDialog);
  await remoteDialog.waitFor({state:'visible'});
  await remoteDialog.locator('[data-volume-reset]').click();
  await remote.waitForFunction(()=>state.data.player_settings.volume_percent===100 && state.data.automatic_volume.status==='manual');
  assert.equal(JSON.parse(readFileSync(path.join(fixture.data,'host-state.json'))).state.automatic_volume.target_lufs,savedTarget);
  await remote.waitForFunction(()=>!document.querySelector('[data-volume-reset]').hasAttribute('aria-busy'));
  await remote.keyboard.press('Escape'); await remote.waitForFunction(()=>!document.querySelector('.volume-adjust-popover').open);
  assert.ok(await page.locator('body').innerText()); assert.ok(await remote.locator('body').innerText());
  if(await tray.isVisible() && await tray.getAttribute('aria-expanded')!=='true')await tray.click();
  await page.locator('#volume-value').click();await settle(dialog);
  const remaining=await host.api('/api/state');
  for(const item of [remaining.current_item,...remaining.playlist].filter(Boolean)) {
    await host.api('/api/playlist/remove',{item_id:item.id});
  }
  const empty=await host.api('/api/state');
  assert.equal(empty.current_item,null);
  assert.equal(empty.automatic_volume.reference_reason,'no_audio');
  assert.equal(empty.automatic_volume.can_reference,false);
  assert.equal((await host.request('/api/player/automatic-volume',{action:'reference',context:remaining.automatic_volume.context})).status,409,
    'the actual Host also rejects reference requests without a song');
  await page.waitForFunction(()=>!state.data.current_item && state.data.automatic_volume.reference_reason==='no_audio');
  assert.equal(await dialog.locator('[data-auto-reference]').isVisible(),true,'the reference action stays visible without a song');
  assert.equal(await dialog.locator('[data-auto-reference]').isDisabled(),true,'no-song reference is visibly disabled');
  assert.equal(await dialog.locator('[data-auto-status]').textContent(),'キャッシュ済みの曲を再生してください。',
    'the final Japanese layout keeps the localized no-song explanation');
  assert.deepEqual(errors,[]);
  const expectedConsole=entry=>entry.text.includes('Viewport argument key "interactive-widget" not recognized') || (new URL(entry.location.url).pathname==='/api/remote/connection-diagnostic' && entry.text.includes('403')) || (['/api/player/status','/api/player/automatic-volume'].includes(new URL(entry.location.url).pathname) && entry.text.includes('409'));
  assert.deepEqual(consoleErrors.filter(entry=>!expectedConsole(entry)),[]);
  const diagnostics=await host.api('/api/diagnostics/native');
  writeFileSync(path.join(evidence,'browser-summary.json'),JSON.stringify({desktopViewport,remoteViewport,engine:'WebKit browser simulation',nativeDesktopHost:true,referenceVolume:50,remoteManualVolume:65,nextAutomaticVolume:next.player_settings.volume_percent,media,disabledResponsiveness,responsiveness,waitingGeometry,geometry,analysis:diagnostics.events.filter(event=>event.event==='automatic-volume-analysis'),errors,consoleErrors},null,2));
});

test('missing or older PCM capability leaves native manual controls usable', {timeout:120000}, async t=>{
  const executable=await buildNativeHost();
  const cases=[undefined];
  if(process.env.BILIKARA_TEST_OLD_LIBAV_COMPANION)cases.push(process.env.BILIKARA_TEST_OLD_LIBAV_COMPANION);
  for(const selected of cases) {
    const home=mkdtempSync(path.join(evidence,'unsupported-'));
    const environment=isolatedEnvironment(home); delete environment.BILIKARA_LIBAV_COMPANION;
    if(selected)environment.BILIKARA_LIBAV_COMPANION=selected;
    const host=await RunningHost.start(executable,home,['--headless','--port','0','--data-dir',path.join(home,'data'),'--static-dir',path.join(root,'static')],environment);
    t.after(()=>host.close());
    await host.api('/api/player/volume',{volume_percent:175});
    assert.equal((await host.api('/api/state')).automatic_volume.enabled,false);
    const result=await host.request('/api/player/automatic-volume',{action:'enable',enabled:true});
    if(!selected)assert.equal(result.status,503);
    else {
      assert.equal(result.status,200);
      await waitFor(async()=>!(await host.api('/api/state')).automatic_volume.scanner_available,'old optional PCM negotiation');
    }
    const snapshot=await host.api('/api/state');assert.equal(snapshot.player_settings.volume_percent,175);
    assert.equal(snapshot.automatic_volume.scanner_available,false);
    await host.api('/api/player/volume',{is_muted:true});
    assert.equal((await host.api('/api/state')).player_settings.is_muted,true);
    assert.equal((await host.api('/api/diagnostics/native')).events.some(event=>event.event==='automatic-volume-analysis'),false);
  }
});
