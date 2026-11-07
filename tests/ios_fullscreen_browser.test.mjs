// Real shared Host, decoders and Signalsmith in Linux browsers. Only the
// WK->UIKit response is a transport fixture, not iPhone appearance evidence.
import assert from 'node:assert/strict';
import {test, before} from 'node:test';
import {readFileSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {chromium, webkit} from 'playwright';
import {root, runNative} from './desktop_construction_support.mjs';
import {ownedDirectory} from './libav_prerequisite_support.mjs';
import {buildNativeAlpha} from './native_runtime_artifacts.mjs';
import {RunningHost, isolatedEnvironment} from './native_host_support.mjs';

let alpha;
before(async () => {if (process.platform === 'linux') alpha = process.env.BILIKARA_TEST_NATIVE_ALPHA_BINARY || await buildNativeAlpha();}, {timeout: 300000});
for (const engine of [chromium, webkit]) test(`${engine.name()} iOS immersive fullscreen retains the split media and DSP graph`,
  {skip: process.platform !== 'linux', timeout: 120000}, async t => {
    const directory = ownedDirectory('ios fullscreen');
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const video = path.join(directory, 'video.mp4'), audio = path.join(directory, 'audio.m4a');
    for (const [file, args] of [
      [video, ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=120', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']],
      [audio, ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=120', '-c:a', 'aac']],
    ]) {
      const result = await runNative('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, file], process.env, 30000);
      assert.equal(result.status, 0, result.stderr);
    }
    const host = await RunningHost.start(alpha, directory, [directory, path.join(root, 'static'), video, audio, '3'], isolatedEnvironment(directory), true);
    t.after(() => host.close());
    const browser = await engine.launch(); t.after(() => browser.close());
    const context = await browser.newContext({viewport: {width: 393, height: 844}, hasTouch: true});
    await context.addCookies([...host.cookies].map(([name, value]) => ({name, value, url: host.base})));
    await context.addInitScript(() => {
      localStorage.setItem('bilikara.update.automatic', 'false');
      window.BILIKARA_PLAYBACK_TRACE = true;
      window.iosNativeRequests = [];
      window.webkit = {messageHandlers: {bilikaraPlatform: {postMessage(value) {
        const request = JSON.parse(value);
        if (request.action === 'sync-dock') {
          queueMicrotask(() => BilikaraIosPlatform._receive({...request,ok:false}));
        } else if (request.id > 0) iosNativeRequests.push(request);
      }}}};
      // Prove the in-app path works when arbitrary-container fullscreen is absent.
      Element.prototype.requestFullscreen = undefined;
      Element.prototype.webkitRequestFullscreen = undefined;
      document.exitFullscreen = undefined;
      document.webkitExitFullscreen = undefined;
    });
    const source = readFileSync(new URL('../static/ios-platform.js', import.meta.url), 'utf8');
    await context.addInitScript(source.replace('"__BILIKARA_IOS_ORIGIN__"', JSON.stringify(host.base)));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); if (url.origin !== host.base) return route.abort();
      if (['/', '/index.html'].includes(url.pathname)) {
        const response = await route.fetch();
        return route.fulfill({response, body: (await response.text()).replace('data-host-platform="android"', 'data-host-platform="ios"')});
      }
      return route.continue();
    });
    const page = await context.newPage(), errors = [], consoleErrors = [], mediaDiagnostics = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text());
      if (message.type() === 'info' && message.text().startsWith('[player-media]')) {
        mediaDiagnostics.push(message.args()[1]?.jsonValue().catch(() => null));
      }
    });
    await page.goto(host.base);
    await page.waitForFunction(() => state.hostPlaybackSession?.phase === 'playing');
    assert.equal(await page.title(), 'bilikara host');
    assert.equal(new URL(page.url()).origin, host.base);
    assert.equal(await page.locator('.app-shell').isVisible(), true);
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal,webpack-dev-server-client-overlay').count(), 0);
    const button = page.locator('#player-fullscreen-button');
    await page.evaluate(() => {
      const item = state.data.current_item;
      state.data.current_item = null; renderPlayerFullscreenButton();
      window.emptyFullscreenDisabled = elements.playerFullscreenButton.disabled;
      state.data.current_item = {...item, cache_status: 'downloading'}; renderPlayerFullscreenButton();
      window.uncachedFullscreenDisabled = elements.playerFullscreenButton.disabled;
      state.data.current_item = item; renderPlayerFullscreenButton();
      document.documentElement.style.setProperty('--ios-safe-top', '47px');
      document.documentElement.style.setProperty('--ios-safe-right', '12px');
      document.documentElement.style.setProperty('--ios-safe-bottom', '34px');
    });
    assert.deepEqual(await page.evaluate(() => [emptyFullscreenDisabled, uncachedFullscreenDisabled]), [true, false]);
    assert.equal(await button.isEnabled(), true);
    if (await page.locator('#stage-controls-toggle').isVisible()) await page.locator('#stage-controls-toggle').click();
    await page.locator('#key-shift-input').fill('2'); await page.locator('#key-shift-input').press('Enter');
    await page.waitForFunction(() => state.hostPlaybackSession.audio.bilikaraPitch?.snapshot().applied === 2);
    await page.locator('#av-offset-input').fill('200'); await page.locator('#av-offset-input').press('Enter');
    await page.waitForFunction(() => currentAvOffsetMs() === 200 && !state.avOffsetSaving);
    if (await page.locator('#stage-controls-close').isVisible()) await page.locator('#stage-controls-close').click();
    // Offset changes re-prime the real pitch processor asynchronously. Start
    // fullscreen retention checks only after that requested output is active.
    await page.waitForFunction(() => {
      const {audio, video} = state.hostPlaybackSession;
      return audio.bilikaraPitch?.snapshot().state === 'active'
        && audio.bilikaraPitch.snapshot().applied === 2 && !audio.paused && !video.paused;
    });
    await page.evaluate(() => {
      const {audio, video} = state.hostPlaybackSession;
      window.immersiveOriginal = {audio, video, audioParent: audio.parentElement, videoParent: video.parentElement,
        gain: audio.bilikaraVolumeGain, pitch: audio.bilikaraPitch, context: state.audioContext,
        variant: state.data.current_item.selected_audio_variant_id};
    });
    async function respond(ok = true) {
      await page.evaluate(ok => {
        const request = iosNativeRequests.at(-1);
        BilikaraIosPlatform._receive({...request, ok, data: {active: request.active}});
      }, ok);
      await page.waitForFunction(() => !state.playerFullscreenTransitioning);
    }
    async function enter() {
      await page.evaluate(() => {
        window.systemControlEvents = [];
        if (window.systemControlObserver) return;
        window.systemControlObserver = true;
        for (const type of ['play','pause','seeking','seeked']) document.addEventListener(type, event => {
          if (event.target !== state.hostPlaybackSession?.video || systemControlEvents.length >= 128) return;
          systemControlEvents.push({type,paused:event.target.paused,marker:event.target.dataset.bilikaraInternalPause,
            seekPending:state.hostPlaybackSession.seekResumePending,seeking:event.target.seeking,
            phase:state.hostPlaybackSession.phase,intent:state.localShouldBePlaying});
        },true);
      });
      const before = await page.evaluate(() => iosNativeRequests.length);
      await button.click();
      await page.evaluate(() => elements.playerFullscreenButton.click());
      assert.equal(await page.evaluate(() => iosNativeRequests.length), before + 1);
      assert.equal(await button.isDisabled(), true);
      await respond();
      await page.waitForFunction(() => isPlayerPanelFullscreen());
      const bounds = await page.locator('.player-panel').boundingBox(), viewport = page.viewportSize();
      assert.deepEqual(bounds, {x: 0, y: 0, ...viewport});
      assert.equal(await page.locator('#android-host-dock').isVisible(), false);
      const exit = await button.boundingBox();
      assert.ok(exit.width >= 44 && exit.height >= 44 && exit.y >= 47 && exit.x + exit.width <= viewport.width - 12, JSON.stringify(exit));
      assert.equal(await page.evaluate(() => document.fullscreenElement), null);
      const video = page.locator('#player-frame video');
      await video.evaluate(node=>{
        window.systemOverlayControlWrites=0;
        window.systemOverlayControlObserver=new MutationObserver(records=>{systemOverlayControlWrites+=records.length;});
        systemOverlayControlObserver.observe(node,{attributes:true,attributeFilter:['controls']});
      });
      let firstRevealWrites;
      for (let tap = 0; tap < 3; tap++) {
        await video.tap({position: {x: 40, y: 60}});
        assert.equal(await page.locator('.inline-playback-controls').count(), 0);
        assert.equal(await page.locator('#presentation-host-controls').isVisible(), false);
        assert.equal(await page.evaluate(() => isPlayerPanelFullscreen()), true, 'repeated taps must not synthesize a fullscreen toggle');
        assert.equal(await video.evaluate(node => node.controls), true, 'deliberate taps reveal the system overlay');
        assert.equal(await video.evaluate(node => node.getAttribute('controlsList')), 'nofullscreen');
        assert.equal(await video.evaluate(node => node.hasAttribute('disablepictureinpicture')), true);
        const writes=await page.evaluate(()=>systemOverlayControlWrites);
        if(tap===0)firstRevealWrites=writes;
        else assert.equal(writes,firstRevealWrites,'later taps leave native overlay visibility to the UA instead of reapplying controls');
      }
      const beforeBubbledTap=await page.evaluate(()=>systemOverlayControlWrites);
      await video.dispatchEvent('click',{bubbles:true});
      assert.equal(await page.evaluate(()=>systemOverlayControlWrites),beforeBubbledTap,
        'a bubbled iOS tap must not reinitialize controls while the system owns their visibility');
      await page.evaluate(()=>systemOverlayControlObserver.disconnect());
      // Exercise the media events emitted by system controls. Linux WebKit's
      // controls skin does not qualify the iPhone overlay's actual buttons.
      // AV/DSP recovery may legitimately interrupt the decoder play request.
      // Establish actual advancing frames before testing a subsequent native
      // pause; phase=playing alone can still describe an internal video hold.
      const beforeNativePause = await video.evaluate(node => {
        window.nativePlayError = "";
        const before = {time:node.currentTime,frames:node.getVideoPlaybackQuality?.().totalVideoFrames ?? node.webkitDecodedFrameCount ?? 0};
        node.play().catch(error => { if(error.name !== 'AbortError') window.nativePlayError=String(error); });
        return before;
      });
      await page.waitForFunction(before => {
        if(window.nativePlayError)throw Error(window.nativePlayError);
        const session=state.hostPlaybackSession;
        if(session.phase !== 'playing' || session.video.paused || session.video.seeking || session.seekSettling || session.seekResumePending || state.localVideoHeldForAudio) return false;
        if(session.video.currentTime <= before.time+.1 || (session.video.getVideoPlaybackQuality?.().totalVideoFrames ?? session.video.webkitDecodedFrameCount ?? 0) <= before.frames+1)return false;
        session.video.pause(); return true;
      }, beforeNativePause);
      await page.waitForFunction(() => !state.localShouldBePlaying && state.hostPlaybackSession.video.paused).catch(async error => {
        console.error('system pause diagnostic', JSON.stringify(await page.evaluate(() => ({player:diagnosticPlayerInfo(),
          marker:state.hostPlaybackSession.video.dataset,seekPending:state.hostPlaybackSession.seekResumePending,
          hidden:document.hidden,events:systemControlEvents})),null,2));throw error;
      });
      await video.evaluate(node => {node.play().catch(() => {});});
      await page.waitForFunction(() => state.localShouldBePlaying && !state.hostPlaybackSession.video.paused).catch(async error => {
        console.error('native control event order',JSON.stringify(await page.evaluate(()=>systemControlEvents),null,2));
        console.error('V7 resume diagnostic', await page.evaluate(() => diagnosticPlayerInfo()));
        console.error('V7 resume events', await Promise.all(mediaDiagnostics));
        throw error;
      });
      await video.evaluate(node => {node.currentTime = 3;});
      await page.waitForFunction(() => !state.hostPlaybackSession.seekSettling);
      assert.ok(await video.evaluate(node => node.currentTime >= 2.8 && node.currentTime < 6));
      const qr = page.locator('#android-fullscreen-remote-button');
      await qr.tap(); assert.equal(await qr.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => isPlayerPanelFullscreen()), true);
      await qr.tap(); assert.equal(await qr.getAttribute('aria-expanded'), 'false');
    }
    for (const viewport of [{width: 393, height: 844}, {width: 844, height: 390}, {width: 320, height: 736}]) {
      await page.setViewportSize(viewport); await enter();
      const time = await page.evaluate(() => {
        const audio = state.hostPlaybackSession.audio;
        return audio.bilikaraAudioClock?.time() ?? audio.currentTime;
      });
      await page.waitForFunction(time => {
        const {audio, video} = state.hostPlaybackSession;
        return (audio.bilikaraAudioClock?.time() ?? audio.currentTime) > time + .2
          && audio.bilikaraPitch?.snapshot().state === 'active'
          && audio.bilikaraPitch.snapshot().applied === 2 && !audio.paused && !video.paused;
      }, time).catch(async error => {
        const diagnostic = await page.evaluate(() => {
          const session = state.hostPlaybackSession, {audio, video} = session;
          return {phase: session.phase, logicalPlayIntent: session.logicalPlayIntent,
            shouldPlay: state.localShouldBePlaying, capturedTime: audio.bilikaraAudioClock?.time(),
            audioTime: audio.currentTime, videoTime: video.currentTime,
            paused: [audio.paused, video.paused], seeking: [audio.seeking, video.seeking],
            context: state.audioContext?.state, pitch: audio.bilikaraPitch?.snapshot(),
            ready: session.readyCommitted, settling: session.seekSettling};
        });
        console.error('fullscreen playback diagnostic', JSON.stringify({viewport, time, diagnostic}));
        if (process.env.BILIKARA_IOS_UI_EVIDENCE) {
          mkdirSync(process.env.BILIKARA_IOS_UI_EVIDENCE, {recursive: true});
          writeFileSync(path.join(process.env.BILIKARA_IOS_UI_EVIDENCE, 'fullscreen-failure.json'), JSON.stringify({viewport, time, diagnostic, errors, consoleErrors, mediaDiagnostics: await Promise.all(mediaDiagnostics)}, null, 2), 'utf8');
          await page.screenshot({path: path.join(process.env.BILIKARA_IOS_UI_EVIDENCE, 'fullscreen-failure.png')});
        }
        throw error;
      });
      const retained = await page.evaluate(() => {
        const original = immersiveOriginal, {audio, video} = state.hostPlaybackSession;
        return {audio: audio === original.audio, video: video === original.video,
          audioParent: audio.parentElement === original.audioParent, videoParent: video.parentElement === original.videoParent,
          gain: audio.bilikaraVolumeGain === original.gain, pitch: audio.bilikaraPitch === original.pitch,
          context: state.audioContext === original.context, applied: audio.bilikaraPitch.snapshot().applied,
          offset: currentAvOffsetMs(), variant: state.data.current_item.selected_audio_variant_id === original.variant,
          playing: !audio.paused && !video.paused, audioTime: audio.currentTime, videoTime: video.currentTime,
          capturedTime: audio.bilikaraAudioClock?.time(), held: state.localVideoHeldForAudio};
      });
      assert.deepEqual(Object.fromEntries(Object.entries(retained).filter(([key]) => !['audioTime','videoTime','capturedTime','held'].includes(key))),
        {audio: true, video: true, audioParent: true, videoParent: true, gain: true, pitch: true, context: true,
          applied: 2, offset: 200, variant: true, playing: true}, JSON.stringify(retained));
      if (process.env.BILIKARA_IOS_UI_EVIDENCE) {
        mkdirSync(process.env.BILIKARA_IOS_UI_EVIDENCE, {recursive: true});
        await page.screenshot({path: path.join(process.env.BILIKARA_IOS_UI_EVIDENCE, `ios-fullscreen-${engine.name()}-${viewport.width}.png`)});
      }
      await button.tap();
      assert.equal(await page.evaluate(() => state.playerFullscreenRemotePinned), false, 'touch exit must not open QR');
      await respond();
      assert.equal(await page.evaluate(() => isPlayerPanelFullscreen()), false);
    }
    // Failed entry rolls back chrome, failed exit preserves the usable exit.
    await button.click(); await respond(false);
    assert.equal(await page.evaluate(() => document.body.classList.contains('is-tauri-fullscreen-active')), false);
    await enter(); await button.click(); await respond(false);
    assert.equal(await page.evaluate(() => isPlayerPanelFullscreen()), true);
    await page.keyboard.press('Escape'); await respond();
    assert.equal(await page.evaluate(() => isPlayerPanelFullscreen()), false);
    // A page retirement rejects pending work and resets CSS before BFCache return.
    await button.click();
    await page.evaluate(() => dispatchEvent(new Event('pagehide')));
    await page.waitForFunction(() => !state.playerFullscreenTransitioning);
    assert.equal(await page.evaluate(() => isPlayerPanelFullscreen()), false);
    await respond(); // stale reply cannot re-enter
    assert.equal(await page.evaluate(() => isPlayerPanelFullscreen()), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors.filter(message => !/^Failed to load resource:/.test(message)), []);
  });
