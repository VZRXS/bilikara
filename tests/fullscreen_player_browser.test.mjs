// Render the production fullscreen/input functions with an actual decoded video.
// The native window bridge is simulated; this is not OS-window certification.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright';

const app = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const helper = readFileSync(new URL('../static/fullscreen-controls.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../static/styles.css', import.meta.url), 'utf8');
const media = readFileSync(new URL('./fixtures/bbdown/video-reordered-start.mp4', import.meta.url)).toString('base64');

test('Edge/Chromium fullscreen keeps entry quiet and restores real pointer, keyboard and touch controls', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<style>
    html,body { margin:0; width:100%; height:100%; }
    #panel { width:700px; height:500px; background:#222; }
    #panel:is(.is-tauri-fullscreen,:fullscreen) { position:fixed; inset:0; width:100%; height:100%; }
    #video { width:100%; height:100%; object-fit:contain; }
    #enter { position:absolute; right:30px; top:20px; z-index:2; }
    ${styles.slice(styles.indexOf('.player-panel:is(:fullscreen, :-webkit-full-screen, .is-tauri-fullscreen).is-player-cursor-hidden'),
      styles.indexOf('.audio-variant-button:hover', styles.indexOf('body.is-presentation-stage-only.is-presentation-cursor-hidden')))}
    </style><section id="panel" class="player-panel"><video id="video" loop muted tabindex="0" src="data:video/mp4;base64,${media}"></video><button id="enter">Fullscreen</button></section>`);
  await page.addScriptTag({ content: helper });
  await page.addScriptTag({ content: `
    const video=document.getElementById('video');
    const elements={playerPanel:document.getElementById('panel')};
    const state={localPlaybackStartState:'established',localPlayerControlsHideTimer:null,
      playerFullscreenTransitioning:false,playerFullscreenRevision:0,data:{current_item:{id:'fixture'}}};
    let nativeMode=true, nativeCalls=0;
    const playerControlsAutoHideMs=5000;
    const fullscreenControlHover={reset(){}};
    const canTogglePlayerFullscreen=()=>!state.playerFullscreenTransitioning;
    const tauriInvoke=()=>nativeMode ? ()=>{} : null;
    async function setTauriWindowFullscreen(){nativeCalls++;return true;}
    const presentationCompositionActive=()=>false;
    const isAndroidNativePlaybackRuntime=()=>false;
    const mountedLocalVideoElement=()=>video;
    const activeLocalPlayerElements=()=>({video,audio:null});
    const addMountedPlayerListener=(target,name,fn,options)=>target.addEventListener(name,fn,options);
    function setPlayerFullscreenRemotePinned(){} function renderPlayerFullscreenButton(){}
    function hideFullscreenRequestToast(){} function hidePlayerDelayOverlay(){}
    function hasLocalAdvanceDelayOverlay(){return false;} function t(key){return key;}
    function setAppMessage(message){throw Error(message);}
    ${section('function fullscreenElement()', 'function isWebKitPlaybackRuntime()')}
    ${section('function isPlayerPanelFullscreen()', 'function isAudiencePlayerSurface()')}
    ${section('function requestElementFullscreen(', 'function clearPlayerFrameClickTimer(')}
    ${section('function clearLocalPlayerControlsHideTimer()', 'function mountedLocalVideoElement()')}
    ${section('function hidePlayerControls(', 'function toggleMountedLocalPlayback()')}
    ${section('function handleFullscreenChange()', 'async function deferCurrentSong(')}
    ${section('state.playerFullscreenInteraction =', 'elements.playerFullscreenButton?.addEventListener("pointerdown"')}
    ${section('  ["pointerenter", "pointermove", "pointerdown", "touchstart", "focus"].forEach', '  addMountedPlayerListener(video, "ended",')}
    document.getElementById('enter').addEventListener('click',togglePlayerFullscreen);
    document.addEventListener('keydown',handleNativePlayerFullscreenEscape);
  ` });
  await page.waitForFunction(() => document.getElementById('video').readyState >= 2);
  await page.evaluate(async () => { await video.play(); window.originalVideo=video; });
  await page.waitForFunction(() => video.currentTime > .15 && !video.paused);
  const controls = () => page.evaluate(() => video.controls);
  const cursor = () => page.evaluate(() => getComputedStyle(video).cursor);
  const cdp = await context.newCDPSession(page);
  async function seekbarBounds() {
    // Inspect the actual Chromium UA-shadow timeline, not a replacement range
    // element: native controls can consume/retarget their own pointer events.
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const pending = [root];
    while (pending.length) {
      const node = pending.pop();
      if (node.attributes?.includes('-webkit-media-controls-timeline')) {
        const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId });
        return { x: model.content[0], y: (model.content[1] + model.content[5]) / 2, width: model.content[2] - model.content[0] };
      }
      pending.push(...(node.children || []), ...(node.shadowRoots || []));
    }
    throw Error('The real native video timeline is missing');
  }

  for (const native of [true, false]) {
    await page.evaluate(async value => { nativeMode=value; await video.play(); }, native);
    await page.mouse.move(250,250); assert.equal(await controls(),true);
    await page.locator('#enter').click();
    await page.waitForFunction(() => isPlayerPanelFullscreen() && !state.playerFullscreenTransitioning);
    assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)),!native);
    assert.equal(await controls(),false,'fullscreen entry must stay quiet');
    assert.equal(await page.evaluate(() => video === window.originalVideo && !video.paused),true,'fullscreen entry preserves active playback');
    await page.evaluate(() => { video.focus(); video.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true,pointerType:'mouse'})); });
    assert.equal(await controls(),false,'automatic focus and hover cannot show controls');
    await page.waitForFunction(() => getComputedStyle(video).cursor === 'none');
    await page.mouse.move(640,400); await page.waitForFunction(() => video.controls);
    assert.notEqual(await cursor(),'none');
    await page.evaluate(() => { video.pause(); video.currentTime=.1; });
    const seekbar = await seekbarBounds();
    await page.mouse.move(seekbar.x + seekbar.width * .25, seekbar.y);
    await page.mouse.down();
    await page.mouse.move(seekbar.x + seekbar.width * .75, seekbar.y, { steps: 5 });
    await page.waitForTimeout(5200);
    assert.equal(await controls(),true,'native control drag cannot lose controls on the five-second timer');
    assert.notEqual(await cursor(),'none');
    await page.mouse.up();
    await page.waitForFunction(() => video.currentTime > video.duration * .6);
    await page.waitForFunction(() => !state.playerFullscreenInteraction.holdingPointer());
    await page.waitForFunction(() => getComputedStyle(video).cursor === 'none');
    await page.evaluate(() => hideMountedPlayerControls());
    await page.locator('#enter').focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await controls(),true,'keyboard focus remains accessible');
    await page.evaluate(() => hideMountedPlayerControls());
    await page.touchscreen.tap(300,300);
    assert.equal(await controls(),true,'touch and the ensuing focus/click leave controls usable');
    assert.equal(await page.evaluate(() => video === window.originalVideo),true,'touch may natively toggle pause, but never replaces the media node');
    const paused = await page.evaluate(() => video.paused);
    await page.locator('#enter').click();
    await page.waitForFunction(() => !isPlayerPanelFullscreen());
    assert.equal(await page.evaluate(() => video.paused),paused,'fullscreen exit preserves the user-selected pause state');
    assert.notEqual(await cursor(),'none');
  }
  // Native fullscreen at the desktop logical minimum still follows the same
  // input policy; width never switches this fixture to Android controls.
  await page.setViewportSize({width:700,height:600});
  await page.evaluate(() => { nativeMode=true; });
  await page.locator('#enter').click(); assert.equal(await controls(),false);
  await page.mouse.move(350,300); await page.waitForFunction(() => video.controls);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !isPlayerPanelFullscreen());
  assert.notEqual(await cursor(),'none');
  assert.equal(await page.evaluate(() => video === window.originalVideo),true);
  assert.deepEqual(errors,[]);
});
