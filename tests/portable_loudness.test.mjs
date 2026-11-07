// The same Rust decoder/Host feature selected by the iOS shell, executed on
// Linux with actual compressed audio. This does not qualify iPhone energy,
// background execution or speakers.
import assert from 'node:assert/strict';
import {test, before} from 'node:test';
import {readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {root, runNative} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {buildNativeAlpha, buildPortableLoudnessAlpha, buildPortableLoudnessTests} from './native_runtime_artifacts.mjs';
import {RunningHost, HttpClient, isolatedEnvironment, waitFor} from './native_host_support.mjs';

let alpha, ordinaryAlpha, binary, directory;
before(async t => {
  if (process.platform !== 'linux') return;
  directory = ownedDirectory('portable loudness');
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  alpha = await buildPortableLoudnessAlpha();
  // Force the previously racy ordering within the existing build/setup budget.
  ordinaryAlpha = await buildNativeAlpha();
  binary = await buildPortableLoudnessTests();
  const oracle = {};
  for (const [name, rate, channels, codec, seconds, gain] of [
    ['aac-44100.m4a', 44100, 2, 'aac', 6, 1], ['aac-48000.m4a', 48000, 1, 'aac', 90, 1],
    ['aac-8000.m4a', 8000, 1, 'aac', 6.03, 1], ['aac-24000.mp4', 24000, 2, 'aac', 6.03, 1],
    ['flac-96000.flac', 96000, 2, 'flac', 6, 1], ['opus-48000.mp4', 48000, 2, 'libopus', 6, 1],
    ['silence.m4a', 48000, 2, 'aac', 2, 0], ['short.m4a', 48000, 2, 'aac', .1, 1],
    ['surround.m4a', 48000, 6, 'aac', 2, 1], ['long.m4a', 48000, 2, 'aac', 1200, 1],
  ]) {
    const file = path.join(directory, name);
    const result = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', `sine=frequency=1000:sample_rate=${rate}`, '-t', String(seconds), '-af', `volume=${gain}`,
      '-ac', String(channels), '-c:a', codec, file], process.env, 60000);
    assert.equal(result.status, 0, result.stderr);
    if (['aac-44100.m4a', 'aac-48000.m4a', 'aac-8000.m4a', 'aac-24000.mp4', 'flac-96000.flac'].includes(name)) {
      const check = await runNative('ffmpeg', ['-hide_banner', '-i', file, '-af', 'ebur128=peak=none', '-f', 'null', '-'], process.env, 60000);
      assert.equal(check.status, 0, check.stderr);
      const values = [...check.stderr.matchAll(/I:\s*(-?[\d.]+) LUFS/g)]; assert.ok(values.length);
      oracle[name] = Number(values.at(-1)[1]);
    }
  }
  for (const [name, expression] of [['aac-quantized.m4a', 'round(PTS*TB*1000)/(TB*1000)'],
    ['aac-gap.m4a', 'PTS+not(not(floor(N/4)))*0.01/TB'], ['aac-overlap.m4a', 'PTS-not(not(floor(N/4)))*0.01/TB']]) {
    const filter = `setts=pts=${expression}:dts=${expression.replaceAll('PTS', 'DTS')}`;
    const result = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(directory, 'aac-48000.m4a'),
      '-map', '0:a:0', '-c:a', 'copy', '-bsf:a', filter, path.join(directory, name)], process.env, 30000);
    assert.equal(result.status, 0, result.stderr);
  }
  // Provider-style two-byte AAC AudioSpecificConfig, obtained via ADTS
  // framing. FFmpeg's ordinary MP4 encoder adds an extension and therefore
  // exercises the separate config-preservation path in the Rust normalizer.
  for (const args of [
    ['-i',path.join(directory,'aac-44100.m4a'),'-c:a','copy','-f','adts',path.join(directory,'provider.aac')],
    ['-i',path.join(directory,'provider.aac'),'-c:a','copy',path.join(directory,'aac-provider.m4a')],
  ]) {
    const result=await runNative('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],process.env,30000);
    assert.equal(result.status,0,result.stderr);
  }
  const providerOracle=await runNative('ffmpeg',['-hide_banner','-i',path.join(directory,'aac-provider.m4a'),
    '-af','ebur128=peak=none','-f','null','-'],process.env,30000);
  assert.equal(providerOracle.status,0,providerOracle.stderr);
  oracle['aac-provider.m4a']=Number([...providerOracle.stderr.matchAll(/I:\s*(-?[\d.]+) LUFS/g)].at(-1)[1]);
  const original = readFileSync(path.join(directory, 'aac-48000.m4a'));
  writeFileSync(path.join(directory, 'truncated.m4a'), original.subarray(0, Math.floor(original.length * .8)));
  writeFileSync(path.join(directory, 'invalid.m4a'), 'invalid compressed audio');
  writeFileSync(path.join(directory, 'oracle.json'), JSON.stringify(oracle));
  const result = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=s=160x90:r=12:d=90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(directory, 'video.mp4')], process.env, 30000);
  assert.equal(result.status, 0, result.stderr);
}, {timeout: 600000});

async function start(t, name = 'aac-48000.m4a') {
  const home = ownedDirectory('portable loudness Host');
  t.after(() => rmSync(home, {recursive: true, force: true}));
  const host = await RunningHost.start(alpha, home, [home, path.join(root, 'static'), path.join(directory, 'video.mp4'),
    path.join(directory, name), '3'], isolatedEnvironment(home), true);
  t.after(() => host.close());
  return {host, home};
}

test('portable scanner fixture retains its features after an ordinary Host fixture build',
  {skip: process.platform !== 'linux', timeout: 90000}, async t => {
    assert.notEqual(alpha, ordinaryAlpha);
    const {host} = await start(t);
    assert.equal((await host.api('/api/state')).automatic_volume.scanner_probe_available, true);
    const home = ownedDirectory('ordinary loudness capability');
    t.after(() => rmSync(home, {recursive: true, force: true}));
    const plain = await RunningHost.start(ordinaryAlpha, home, [home, path.join(root, 'static')], isolatedEnvironment(home), true);
    t.after(() => plain.close());
    assert.equal((await plain.api('/api/state')).automatic_volume.scanner_probe_available, false);
  });

test('portable scanner matches independent FFmpeg, accepts retained Rust AAC and rejects incomplete/unsupported tracks',
  {skip: process.platform !== 'linux', timeout: 120000}, async t => {
    // Run both fixture-backed suites explicitly; the separately supplied
    // external-artifact experiment has its own input/reference contract.
    const results = [];
    for (const name of ['actual_compressed_audio_oracle_cancellation_and_failures',
      'portable_artifact_fact_reuse_and_replacement']) {
      results.push(await runNative(binary, [name, '--ignored', '--nocapture'],
        {...process.env, BILIKARA_TEST_LOUDNESS_FIXTURES: directory}, 90000));
    }
    const result = {status: results.find(row => row.status !== 0)?.status || 0,
      stdout: results.map(row => row.stdout).join('\n'), stderr: results.map(row => row.stderr).join('\n')};
    if (process.env.BILIKARA_IOS_UI_EVIDENCE) {
      mkdirSync(process.env.BILIKARA_IOS_UI_EVIDENCE, {recursive: true});
      writeFileSync(path.join(process.env.BILIKARA_IOS_UI_EVIDENCE, 'portable-loudness.txt'), result.stdout + result.stderr, 'utf8');
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const {host} = await start(t, 'legacy-aac-provider.m4a');
    await host.api('/api/player/automatic-volume', {action:'enable', enabled:true});
    const measured = await waitFor(async()=>{
      const snapshot=await host.api('/api/state');return snapshot.automatic_volume.can_reference && snapshot;
    }, 'retained Rust AAC verification', 30000);
    assert.equal(measured.automatic_volume.scanner_available, true);
    assert.equal(measured.player_settings.volume_percent, 100, 'verification preserves manual level');
  });

test('native Host verifies before enabling; malformed and cancelled scans preserve manual volume',
  {skip: process.platform !== 'linux', timeout: 90000}, async t => {
    const {host, home} = await start(t, 'long.m4a');
    const initial = await host.api('/api/state');
    assert.equal(initial.automatic_volume.scanner_available, false);
    assert.equal(initial.automatic_volume.scanner_probe_available, true);
    assert.equal(initial.automatic_volume.enabled, false);
    const relative = new URL(initial.current_item.audio_variants[0].audio_url, host.base).pathname.slice('/media/'.length);
    const source = path.resolve(home, 'media', relative);
    assert.ok(source.startsWith(home + path.sep));
    assert.equal(existsSync(source + '.loudness.json'), false, 'OFF admits no scan or sidecar');
    const license = await host.request('/vendor/symphonia/LICENSE.txt');
    assert.equal(license.status, 200); assert.match(license.body.toString('utf8'), /Mozilla Public License/);
    const phone = new HttpClient(host.base); await phone.request('/remote');
    assert.equal((await phone.request('/api/player/automatic-volume', {action: 'enable', enabled: true})).status, 403);
    assert.equal((await host.request('/api/player/automatic-volume', {action: 'enable', enabled: true, unexpected: 1})).status, 400);
    await host.api('/api/player/volume', {volume_percent: 61});
    const request = host.request('/api/player/automatic-volume', {action: 'enable', enabled: true});
    await waitFor(async () => (await host.api('/api/state')).automatic_volume.scanner_verifying, 'active scanner proof');
    assert.equal((await host.request('/api/player/automatic-volume', {action: 'enable', enabled: true})).status, 409);
    await host.api('/api/player/volume', {volume_percent: 62});
    assert.equal((await request).status, 409);
    const cancelled = await host.api('/api/state');
    assert.equal(cancelled.automatic_volume.scanner_available, false);
    assert.equal(cancelled.automatic_volume.enabled, false);
    assert.equal(cancelled.player_settings.volume_percent, 62);
    const second = host.request('/api/player/automatic-volume', {action: 'enable', enabled: true});
    const verifying = await waitFor(async () => { const state = await host.api('/api/state'); return state.automatic_volume.scanner_verifying && state; }, 'second active scanner proof');
    const cancelPayload = {action:'cancel', context:verifying.automatic_volume.context, analysis_epoch:verifying.automatic_volume.analysis_epoch};
    await host.api('/api/player/automatic-volume', cancelPayload);
    assert.equal((await second).status, 409);
    assert.equal((await host.request('/api/player/automatic-volume', cancelPayload)).status, 409, 'stale cancellation cannot cancel a new epoch');
    assert.equal((await host.api('/api/state')).automatic_volume.enabled, initial.automatic_volume.enabled);
    const {host: invalid, home: invalidHome} = await start(t, 'invalid.m4a');
    const invalidState = await invalid.api('/api/state');
    const invalidRelative = invalidState.current_item.audio_variants[0].audio_url.slice('/media/'.length);
    const invalidPath = path.join(invalidHome, 'media', invalidRelative), identity = statSync(invalidPath, {bigint: true});
    // Even a matching old sidecar cannot qualify a new process/device. The
    // first enable must decode the bytes, so this invalid file still fails.
    const saved = JSON.stringify({schema: 1, bytes: Number(identity.size), modified_nanos: 'TIME',
      fact: {algorithm: 'ebur128-0.1.10-i-histogram-pcm-v1', integrated_lufs: -21,
        duration_seconds: 90, elapsed_seconds: .1, sample_rate: 48000, channels: 1, codec: 'aac'}})
      .replace('"TIME"', identity.mtimeNs.toString());
    writeFileSync(invalidPath + '.loudness.json', saved, 'utf8');
    const failed = await invalid.request('/api/player/automatic-volume', {action: 'enable', enabled: true});
    assert.equal(failed.status, 503);
    assert.equal(JSON.parse(failed.body.toString('utf8')).analysis_reason, 'unsupported_container');
    const failures = (await invalid.api('/api/diagnostics/native')).events
      .filter(event => event.event === 'automatic-volume-analysis-failed');
    assert.ok(failures.some(event => event.reason === 'unsupported_container' && event.phase === 'verification'));
    assert.ok(!JSON.stringify(failures).includes(invalidHome), 'scanner diagnostics must not expose artifact paths');
    assert.equal((await invalid.api('/api/state')).automatic_volume.enabled, false);
    const {host: gap} = await start(t, 'aac-gap.m4a');
    const gapFailure = await gap.request('/api/player/automatic-volume', {action: 'enable', enabled: true});
    assert.equal(gapFailure.status, 503);
    assert.equal(JSON.parse(gapFailure.body.toString('utf8')).analysis_reason, 'duration_mismatch');
    const gapDiagnostic = (await gap.api('/api/diagnostics/native')).events.find(row => row.reason === 'duration_mismatch');
    assert.equal(gapDiagnostic.scan.codec, 'aac');
    assert.ok(gapDiagnostic.scan.packet_index > 1);
    assert.ok(gapDiagnostic.scan.packet_duration > .025, 'the remuxed discontinuity lengthens a packet beyond its decoded block');
    assert.ok(!JSON.stringify(gapDiagnostic).includes(directory));
    const {host: flac} = await start(t, 'flac-96000.flac');
    const enabled = await flac.api('/api/player/automatic-volume', {action: 'enable', enabled: true});
    assert.equal(enabled.automatic_volume.enabled, true);
    assert.equal(enabled.automatic_volume.scanner_available, true);
    assert.equal(enabled.automatic_volume.calibrated, false);
  });

for (const engine of [chromium, webkit]) test(`${engine.name()} iOS automatic volume first analyzes real cached audio with a dismissible UI [IOS-09-06]`,
  {skip: process.platform !== 'linux', timeout: 90000}, async t => {
    const {host} = await start(t);
    await host.api('/api/player/volume', {volume_percent: 63});
    const browser = await engine.launch(); t.after(() => browser.close());
    const context = await browser.newContext({viewport: {width: 393, height: 844}, hasTouch: true});
    await context.addCookies([...host.cookies].map(([name, value]) => ({name, value, url: host.base})));
    await context.addInitScript(() => localStorage.setItem('bilikara.update.automatic', 'false'));
    let release, held, commands = 0;
    const hold = new Promise(resolve => {held = resolve;});
    const pending = new Promise(resolve => {release = resolve;});
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); if (url.origin !== host.base) return route.abort();
      if (url.pathname === '/api/player/automatic-volume' && route.request().postDataJSON()?.enabled === true) {
        commands++; const response = await route.fetch(); held(); await pending; return route.fulfill({response});
      }
      if (['/', '/index.html'].includes(url.pathname)) {
        const response = await route.fetch(); return route.fulfill({response,
          body: (await response.text()).replace('data-host-platform="android"', 'data-host-platform="ios"')});
      }
      return route.continue();
    });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(host.base); await page.waitForFunction(() => state.hasValidStateResponse);
    assert.equal(await page.title(), 'bilikara host');
    assert.equal(new URL(page.url()).origin, host.base);
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal,webpack-dev-server-client-overlay').count(), 0);
    if (await page.locator('#stage-controls-toggle').isVisible()) await page.locator('#stage-controls-toggle').click();
    await page.locator('#volume-value').click();
    const dialog = page.locator('.volume-adjust-popover'), toggle = dialog.locator('[data-auto-switch]');
    await dialog.waitFor({state: 'visible'});
    await dialog.evaluate(node => Promise.allSettled(node.getAnimations().map(animation => animation.finished)));
    assert.equal(await toggle.isEnabled(), true);
    assert.equal(await toggle.isChecked(), false);
    await dialog.locator('.automatic-volume-toggle').tap(); await hold;
    assert.equal(await toggle.isDisabled(), true);
    assert.equal(await toggle.getAttribute('aria-busy'), 'true');
    await toggle.evaluate(node => node.click()); assert.equal(commands, 1);
    assert.equal(await dialog.locator('[data-volume-close]').isEnabled(), true);
    await dialog.locator('[data-volume-close]').tap();
    await dialog.waitFor({state: 'hidden'});
    await page.locator('[data-android-page="my"]').tap();
    await page.locator('[data-android-page="my"]').focus();
    release();
    await page.waitForFunction(() => !document.querySelector('[data-auto-switch]').disabled);
    assert.equal(await dialog.isVisible(), false, 'late analysis must not reopen its closed UI lease');
    assert.equal(await page.locator('[data-android-page="my"]').evaluate(node => node === document.activeElement), true, 'late result cannot steal navigation focus');
    await page.locator('[data-android-page="playback"]').tap();
    await page.locator('#volume-value').click();
    await page.waitForFunction(() => state.data.automatic_volume.enabled && !document.querySelector('[data-auto-switch]').disabled);
    assert.equal(await toggle.isChecked(), true);
    assert.equal((await host.api('/api/state')).player_settings.volume_percent, 63);
    assert.equal((await host.api('/api/state')).automatic_volume.calibrated, false);
    if (process.env.BILIKARA_IOS_UI_EVIDENCE) {
      mkdirSync(process.env.BILIKARA_IOS_UI_EVIDENCE, {recursive: true});
      await page.screenshot({path: path.join(process.env.BILIKARA_IOS_UI_EVIDENCE, `ios-automatic-volume-${engine.name()}.png`)});
    }
    assert.deepEqual(errors, []);
  });

for (const engine of [chromium, webkit]) test(`${engine.name()} long native analysis permits cancel, navigation and foreground recovery [IOS-09-06]`,
  {skip: process.platform !== 'linux', timeout: 180000}, async t => {
    const {host} = await start(t, 'long.m4a');
    const browser = await engine.launch(); t.after(() => browser.close());
    const context = await browser.newContext({viewport:{width:393,height:844},hasTouch:true});
    await context.addCookies([...host.cookies].map(([name,value])=>({name,value,url:host.base})));
    await context.addInitScript(()=>localStorage.setItem('bilikara.update.automatic','false'));
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url()); if(url.origin!==host.base)return route.abort();
      if(['/', '/index.html'].includes(url.pathname)){
        const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('data-host-platform="android"','data-host-platform="ios"')});
      }
      return route.continue();
    });
    const page=await context.newPage(), errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(host.base);await page.waitForFunction(()=>state.hasValidStateResponse);
    const before=(await host.api('/api/state')).automatic_volume;
    if(await page.locator('#stage-controls-toggle').isVisible())await page.locator('#stage-controls-toggle').click();
    await page.locator('#volume-value').click();
    const dialog=page.locator('.volume-adjust-popover'), toggle=dialog.locator('[data-auto-switch]');
    await dialog.locator('.automatic-volume-toggle').tap();
    await page.waitForFunction(()=>state.data.automatic_volume.scanner_verifying);
    const epoch=(await host.api('/api/state')).automatic_volume.analysis_epoch;
    await dialog.locator('[data-auto-cancel]').tap();
    await page.waitForFunction(()=>!state.data.automatic_volume.scanner_verifying&&!document.querySelector('[data-auto-switch]').disabled);
    assert.equal((await host.api('/api/state')).automatic_volume.enabled,before.enabled);
    assert.equal((await host.api('/api/state')).automatic_volume.calibrated,before.calibrated);
    assert.equal(await dialog.locator('.volume-adjust-error').isVisible(),false,'cancelled original request is not a late UI error');
    // Qualification decodes a real 20-minute track and owns a 120-second
    // backend budget. Measure UI settlement separately, after that HTTP job
    // actually returns; CPU competition is not a foreground recovery failure.
    const verifiedResponse=page.waitForResponse(response=>{
      const request=response.request();
      return new URL(response.url()).pathname==='/api/player/automatic-volume'
        &&request.method()==='POST'&&request.postDataJSON()?.action==='enable'
        &&request.postDataJSON()?.enabled===true;
    },{timeout:125000});
    verifiedResponse.catch(()=>{});
    await dialog.locator('.automatic-volume-toggle').tap();
    await page.waitForFunction(epoch=>state.data.automatic_volume.scanner_verifying&&state.data.automatic_volume.analysis_epoch>epoch,epoch);
    await page.evaluate(async()=>{
      window.analysisMedia=[state.hostPlaybackSession.video,state.hostPlaybackSession.audio];
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
      if(state.audioContext)await state.audioContext.suspend();
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await dialog.locator('[data-volume-close]').tap();await dialog.waitFor({state:'hidden'});
    await page.locator('[data-android-page="my"]').tap();
    await page.locator('[data-android-page="my"]').focus();
    try {
      const response=await verifiedResponse;
      assert.equal(response.status(),200,'actual scanner verification must succeed before UI recovery is assessed');
      const verified=await response.json();
      assert.equal(verified.data.automatic_volume.enabled,true);
      assert.equal(verified.data.automatic_volume.scanner_verifying,false);
      await page.waitForFunction(()=>state.data.automatic_volume.enabled&&!document.querySelector('[data-auto-switch]').disabled,null,{timeout:45000});
    } catch(error) {
      const evidence=process.env.BILIKARA_SHARED_PLAYBACK_EVIDENCE||process.env.BILIKARA_IOS_UI_EVIDENCE;
      if(evidence) {
        mkdirSync(evidence,{recursive:true});
        const snapshot=await host.api('/api/state');
        const browser=await page.evaluate(()=>({automatic:state.data?.automatic_volume,
          disabled:document.querySelector('[data-auto-switch]')?.disabled,
          busy:document.querySelector('[data-auto-switch]')?.getAttribute('aria-busy'),
          error:document.querySelector('.volume-adjust-error')?.textContent}));
        writeFileSync(path.join(evidence,`loudness-${engine.name()}-failure.json`),
          JSON.stringify({source:'isolated actual Rust Host with generated audio',host:snapshot.automatic_volume,browser,errors},null,2));
      }
      throw error;
    }
    assert.equal(await dialog.isVisible(),false);
    assert.equal(await page.locator('[data-android-page="my"]').evaluate(node=>node===document.activeElement),true);
    assert.equal(await page.evaluate(()=>analysisMedia[0]===state.hostPlaybackSession.video&&analysisMedia[1]===state.hostPlaybackSession.audio),true);
    assert.equal((await host.api('/api/state')).automatic_volume.calibrated,false);
    await host.api('/api/player/automatic-volume',{action:'enable',enabled:false});
    assert.equal((await host.api('/api/state')).automatic_volume.enabled,false);
    assert.deepEqual(errors,[]);
  });
