// R1 T6 scenarios remounted in next's Manage dialog (decision 1).
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {openManage,idle,dictionary,appSection} from './cast_browser_support.mjs';

test('native presentation snapshots keep one renderer owner and reject mismatched or stale counters',()=>{
  const normalize=vm.runInNewContext(appSection('const presentationModes =','function presentationPhaseRank(')+'normalizePresentationSession');
  const candidate={mode:'singleScreen',phase:'inactive',generation:1,playbackAuthority:'host',mediaRendererOwner:'host'};
  for(const [mode,owner]of [['singleScreen','host'],['localDualScreen','host'],['networkRenderer','networkRenderer']]){
    assert.equal(normalize({...candidate,mode,mediaRendererOwner:owner}).mediaRendererOwner,owner);
    assert.equal(normalize({...candidate,mode,mediaRendererOwner:owner==='host'?'networkRenderer':'host'}),null);
  }
  for(const patch of [{playbackAuthority:'controller'},{generation:-1},{generation:2**53},{lastAcceptedCommandSequence:1,lastAppliedCommandSequence:2}])assert.equal(normalize({...candidate,...patch}),null);
});

test('Manage rows retain identity, preference conflicts retry once, and pending actions reject duplicates',async t=>{
  const page=await openManage(t),mode=page.locator('[data-cast-device="one"] [data-cast-mode="live"]');
  await mode.click();assert.equal(await mode.isDisabled(),true);assert.equal(await mode.getAttribute('aria-busy'),'true');
  await mode.dispatchEvent('click');assert.equal(await page.evaluate(()=>fixture.calls.length),1);
  assert.deepEqual(await page.evaluate(()=>fixture.calls[0].payload),{command:'cast.set_device_mode',device_key:'one',mode:'live',revision:5});
  await page.evaluate(()=>{window.row=document.querySelector('[data-cast-device="one"]');fixture.reject('cast_revision_conflict');});
  await page.waitForFunction(()=>fixture.calls.length===2);
  assert.equal(await page.evaluate(()=>fixture.calls[1].payload.revision),6);
  await page.evaluate(()=>fixture.reject('cast_revision_conflict'));await idle(page,'[data-cast-mode="live"]');
  assert.equal(await page.evaluate(()=>fixture.refreshes()),2);
  assert.equal(await page.locator('#purek-error').innerText(),dictionary.zh['cast.error.cast_revision_conflict']);
  await page.evaluate(()=>fixture.update({cast:{position:12,renderers:[{device_key:'one',label:'Renamed'},{device_key:'three',label:'New'}]}}));
  assert.equal(await page.evaluate(()=>window.row===document.querySelector('[data-cast-device="one"]')),true);
  assert.equal(await page.locator('[data-cast-device="two"]').count(),0);
  assert.equal(await page.locator('[data-cast-compatibility-test]:visible').count(),0,'P10 backend capability is required');
  await page.locator('#purek-close').click();await page.locator('#purek-open').click();
  assert.equal(await page.locator('#purek-error').isVisible(),false);
});

test('Manage mode retry rechecks receiver existence and preserves a successful preference',async t=>{
  const page=await openManage(t),mode=page.locator('[data-cast-device="one"] [data-cast-mode="live"]');
  await mode.click();await page.evaluate(()=>fixture.reject('cast_revision_conflict'));await page.waitForFunction(()=>fixture.calls.length===2);
  await page.evaluate(()=>fixture.resolve({...state.data,cast:{...state.data.cast,devices:{one:{mode:'live'}}}}));await idle(page,'[data-cast-mode="live"]');
  assert.equal(await mode.getAttribute('aria-pressed'),'true');assert.equal(await mode.getAttribute('aria-selected'),null);
  await page.locator('[data-cast-device="one"] [data-cast-mode="file"]').click();
  await page.evaluate(()=>{state.data.cast.renderers=[];fixture.reject('cast_revision_conflict');});
  await page.waitForFunction(()=>!document.getElementById('purek-error').hidden);
  assert.equal(await page.evaluate(()=>fixture.calls.length),3);
  assert.equal(await page.locator('#purek-error').innerText(),dictionary.zh['cast.error.cast_device_preferences_unavailable']);
});

test('discovery waits beyond 45 seconds for the authoritative terminal phase and cancellation cleanup',async t=>{
  const page=await openManage(t);await page.clock.install();await page.locator('#cast-discover').click();
  await page.evaluate(()=>{fixture.update({cast:{phase:'discovering',busy:true,operation_id:1}});fixture.resolve({accepted:true,operation_id:1});});
  await page.clock.fastForward(90000);
  assert.equal(await page.locator('#cast-discover').getAttribute('aria-busy'),'true');
  await page.locator('#cast-cancel-operation').click();
  await page.evaluate(()=>{fixture.update({cast:{phase:'recovering',busy:true,operation_id:2}});fixture.resolve({accepted:true,operation_id:2});});
  assert.equal(await page.locator('#cast-cancel-operation').getAttribute('aria-busy'),'true');
  await page.evaluate(()=>fixture.update({cast:{phase:'idle',busy:false}}));
  await idle(page,'#cast-discover');await idle(page,'#cast-cancel-operation');
  assert.equal(await page.locator('#cast-discover').isEnabled(),true);
});

test('manual acquisition uses next prepare and preserves QR variants and the draft through snapshots',async t=>{
  const page=await openManage(t);await page.locator('#purek-dlna-entry summary').click();
  for(const raw of ['https://WX.CHUNK.CN:8443/Projection/Login/?projection_url=fixture#room','http://wx.chunk.cn/projection/login?projection_url=a+b','http://192.168.1.2:8080/description.xml']){
    await page.locator('#purek-dlna-url').fill(raw);await page.locator('#purek-address-confirmed').check();
    await page.locator('#purek-dlna-connect').click();
    assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1)),{path:'/api/purek/prepare',payload:{url:raw}});
    await page.evaluate(()=>fixture.update({cast:{position:99}}));assert.equal(await page.locator('#purek-dlna-url').inputValue(),raw);
    await page.evaluate(()=>fixture.reject('purek_qr_invalid'));await idle(page,'#purek-dlna-connect');
    assert.match(await page.locator('#purek-error').innerText(),/purek_qr_invalid/);
  }
  assert.equal(await page.locator('#purek-address-confirmed').isChecked(),true);
});

test('manual acquisition retains native URL validation and Rust rejects invalid/oversized QR input',async t=>{
  const page=await openManage(t);await page.locator('#purek-dlna-entry summary').click();
  await page.locator('#purek-dlna-url').fill('not a URL');await page.locator('#purek-dlna-connect').click();
  assert.equal(await page.evaluate(()=>fixture.calls.length),0);
  for(const raw of ['https://wx.chunk.cn.example.com/projection/login','https://wx.chunk.cn/projection/login?data='+'房'.repeat(11000)]){
    await page.locator('#purek-dlna-url').fill(raw);await page.locator('#purek-dlna-connect').click();
    assert.equal(await page.evaluate(()=>fixture.calls.at(-1).path),'/api/purek/prepare');
    await page.evaluate(()=>fixture.reject('purek_qr_invalid'));await idle(page,'#purek-dlna-connect');
    assert.match(await page.locator('#purek-error').innerText(),/purek_qr_invalid/);
  }
  assert.equal(await page.evaluate(()=>fixture.calls.some(c=>c.path==='/api/cast/connect')),false);
});

test('connection preserves physical output; the output switch reserves native ownership until suspension',async t=>{
  const page=await openManage(t);
  await page.evaluate(()=>{fixture.native();state.presentationSession={mode:'localDualScreen',phase:'active',generation:1};});
  await page.locator('[data-cast-connect="one"]').click();
  assert.deepEqual(await page.evaluate(()=>fixture.calls),[{path:'/api/cast/connect',payload:{device_key:'one'}}]);
  await page.evaluate(()=>{fixture.update({cast:{phase:'active',operation_id:1,connected:true,selected:'one'},purek:{connected:true,room_name:'Living room'},media_output:{authorized:true}});fixture.resolve({operation_id:1});});
  await idle(page,'[data-cast-connect="one"]');
  assert.equal(await page.evaluate(()=>state.presentationSession.mode),'localDualScreen');
  await page.locator('#purek-close').click();
  await page.locator('[data-media-output="settings"] .media-output-targets').click();
  await page.waitForFunction(()=>!BilikaraMediaOutput.busy());
  assert.equal(await page.evaluate(()=>fixture.calls.length),1,'physical display must be closed explicitly before changing output');
  assert.equal(await page.evaluate(()=>fixture.messages.at(-1)),dictionary.zh['mediaOutput.closeDisplay']);
  await page.evaluate(()=>fixture.finishPhysical());
  await page.locator('[data-media-output="settings"] .media-output-targets').click();
  await page.waitForFunction(()=>fixture.calls.some(c=>c.path==='/api/player/output'));
  assert.equal(await page.locator('#purek-open').isDisabled(),true,'connection actions cannot race pending output admission');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.slice(-2)),[{native:'set_network_presentation',args:{active:true,generation:2}},{path:'/api/player/output',payload:{target:'purek',experimental:true}}]);
  await page.evaluate(()=>{fixture.update({cast:{position:5}});});
  assert.equal(await page.evaluate(()=>state.presentationSession.mode),'networkRenderer','unrelated snapshots cannot release an in-flight output reservation');
  await page.evaluate(()=>fixture.resolve({...state.data,media_output:{...state.data.media_output,target:'purek'}}));
  await page.waitForFunction(()=>!BilikaraMediaOutput.busy());
  await page.evaluate(()=>fixture.update({media_output:{target:'local'}}));
  await page.waitForFunction(()=>state.presentationSession.mode==='singleScreen');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1).args),{active:false,generation:3});
  assert.equal(await page.evaluate(()=>state.data.cast.connected),true,'suspension retains the connection');
});

test('network admission waits for physical recovery and releases its lease when output fails',async t=>{
  const page=await openManage(t);
  await page.evaluate(()=>{
    fixture.native();state.presentationSession={mode:'localDualScreen',phase:'active',generation:1};
    window.outputFailure=null;
    void BilikaraPureK.requestOutput('/api/player/output',{target:'purek',experimental:true}).catch(error=>{window.outputFailure=error;});
  });
  assert.deepEqual(await page.evaluate(()=>fixture.calls),[{native:'closePhysical'}]);
  await page.evaluate(()=>fixture.finishPhysical());
  await page.waitForFunction(()=>fixture.calls.some(c=>c.path==='/api/player/output'));
  assert.deepEqual(await page.evaluate(()=>fixture.calls.slice(-2)),[{native:'set_network_presentation',args:{active:true,generation:2}},{path:'/api/player/output',payload:{target:'purek',experimental:true}}]);
  await page.evaluate(()=>fixture.reject('purek_output_backend_unavailable'));
  await page.waitForFunction(()=>state.presentationSession.mode==='singleScreen');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.at(-1).args),{active:false,generation:3});
  assert.equal(await page.evaluate(()=>window.outputFailure.code),'purek_output_backend_unavailable');
});

test('Manage self-test opens for its receiver, stays above Manage, and restores the device-row focus',async t=>{
  const page=await openManage(t,{selfTest:true});
  const trigger=page.locator('[data-cast-device="one"] [data-cast-compatibility-test]');
  await trigger.click();assert.equal(await page.locator('[data-test-device]').inputValue(),'one');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#cast-self-test').isVisible(),false);
  assert.equal(await page.locator('#purek-modal').isVisible(),true);
  assert.equal(await trigger.evaluate(n=>n===document.activeElement),true);
});

test('temporary preferences and Manage geometry remain stable at 700/360/320px in three languages',async t=>{
  const page=await openManage(t,{selfTest:true});
  await page.evaluate(()=>window.originalRow=document.querySelector('[data-cast-device="one"]'));
  for(const width of [700,360,320])for(const language of ['zh','en','ja']){
    await page.setViewportSize({width,height:800});await page.evaluate(language=>fixture.language(language),language);
    const row=page.locator('[data-cast-device="one"]');
    assert.equal(await row.locator('.cast-mode-label').innerText(),dictionary[language]['cast.deliveryThisRun']);
    assert.equal(await page.evaluate(()=>window.originalRow===document.querySelector('[data-cast-device="one"]')),true);
    assert.equal(await page.locator('.purek-card').evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
    for(const selector of ['#cast-discover','[data-cast-connect="one"]','[data-cast-device="one"] [data-cast-compatibility-test]'])assert.equal(await page.locator(selector).evaluate(n=>n.getBoundingClientRect().height),44);
    assert.equal(await row.locator('.cast-modes').evaluate(n=>n.getBoundingClientRect().height),48);
    const geometry=await page.locator('.purek-card').evaluate(n=>{
      const card=n.getBoundingClientRect(),close=n.querySelector('#purek-close').getBoundingClientRect(),title=getComputedStyle(n.querySelector('h2'));
      return {close:[close.width,close.height],right:card.right-close.right,top:close.top-card.top,title:[title.fontSize,title.lineHeight],inset:parseFloat(getComputedStyle(n).paddingLeft)};
    });
    assert.deepEqual(geometry.close,[32,32]);assert.deepEqual(geometry.title,['18px','24px']);assert.equal(geometry.inset,20);
    assert.ok(Math.abs(geometry.top-16)<=1&&Math.abs(geometry.right-16)<=1,JSON.stringify(geometry));
  }
});

test('Host DSP controls follow L0/L1 availability without losing pending guards or help access',async t=>{
  const page=await openManage(t);
  await page.evaluate(()=>{
    document.body.insertAdjacentHTML('beforeend','<section id="dsp-key"><button data-step="-1">-1</button><input><button id="dsp-reset">Reset</button><button class="cache-advanced-info-button">i</button><span id="host-key-shift-info"></span></section><section id="dsp-delay"><button data-step="-50">-50</button><input><button id="delay-reset">Reset</button><button id="delay-lock">Lock</button><button class="cache-advanced-info-button">i</button><span id="host-av-sync-info"></span></section>');
    window.elements={keyShiftPanel:document.getElementById('dsp-key'),keyShiftInput:document.querySelector('#dsp-key input'),keyShiftResetButton:document.getElementById('dsp-reset'),avSyncPanel:document.getElementById('dsp-delay'),avOffsetInput:document.querySelector('#dsp-delay input'),avOffsetResetButton:document.getElementById('delay-reset'),avDelayLockButton:document.getElementById('delay-lock')};
    window.setClassToggle=(n,k,v)=>n.classList.toggle(k,v);window.setTextContent=(n,v)=>n.textContent=v;window.currentAvOffsetMs=()=>0;window.activeLocalPlayerElements=()=>({});
  });
  await page.addScriptTag({content:appSection('function networkDspUnavailable()', 'async function setLocalPlayerKeyShift(')+appSection('function renderAvSyncControls(', 'function createSplitPlayerStartupSynchronizer(')});
  for(const [target,level,blocked]of [['purek','L0',true],['purek',null,true],['purek','L1',false],['local','L0',false],['native','L1',false]]){
    await page.evaluate(({target,level})=>{state.data.media_output={target,pipeline_level:level};state.data.player_settings.key_shift=2;renderKeyShiftControls('local');renderAvSyncControls('local',{av_delay:{has_local_adjustment:true,lock_button_enabled:true}});},{target,level});
    for(const control of await page.locator('#dsp-key input,#dsp-delay input,#dsp-key button:not(.cache-advanced-info-button),#dsp-delay button:not(.cache-advanced-info-button)').all()){
      assert.equal(await control.isDisabled(),blocked);assert.match(await control.getAttribute('aria-describedby'),/host-(key-shift|av-sync)-info/);
    }
    assert.equal(await page.locator('#dsp-key .cache-advanced-info-button').isEnabled(),true);
    if(blocked)assert.equal(await page.locator('#host-key-shift-info').innerText(),dictionary.zh['mediaOutput.dspUnavailable']);
  }
  await page.evaluate(()=>{elements.keyShiftResetButton.setAttribute('aria-busy','true');state.avOffsetSaving=true;renderKeyShiftControls('local');renderAvSyncControls('local',{});});
  assert.equal(await page.locator('#dsp-reset').isDisabled(),true);assert.equal(await page.locator('#dsp-delay input').isDisabled(),true);
});
